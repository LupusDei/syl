import { afterEach, describe, expect, it } from "vitest";

import type { Job } from "@syl/shared";

import type { QuietHours } from "../../src/harness/schedule.js";
import type { TurnResult } from "../../src/harness/session.js";
import {
  agendaWallTime,
  ANNOUNCEMENT_WALL_TIME,
  COMPOSE_LEAD_MS,
  createMorningAgendaHandler,
  defineMorningAgendaJob,
  describeAgenda,
  ensureMorningAgendaJob,
  agendaPrompt,
  MORNING_AGENDA_WALL_TIME,
  PUTS_IT_IN_FRONT_OF_HIM,
  type AgendaVoice,
} from "../../src/jobs/agenda-job.js";
import { RHYTHM_GRACE_MS } from "../../src/jobs/deliver-reminders.js";
import { instant } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { JobContext } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { mcpToolName } from "../../src/tools/config.js";
import { advertisedToolNames } from "../../src/tools/server.js";
import { testDatabase } from "../helpers/service.js";

/**
 * The morning agenda (`syl-agd`).
 *
 * `LANES.agenda` has existed since the harness was written and three files'
 * comments described the morning brief as part of her rhythm. Nothing defined
 * it and nothing scheduled it, so the only thing that arrived at 07:00 was a
 * note announcing a brief that was never composed.
 *
 * The property the whole job turns on is an ORDERING: the brief exists before
 * the note that announces it. Everything else here — the zone, the grace
 * window, the hands — is in service of that, and the clock is injected
 * everywhere so no assertion depends on the hour the suite happens to run at.
 */

const TZ = "America/Chicago";
const QUIET: QuietHours = { start: "22:00", end: "08:00" };

/** 06:45 CDT on Tuesday 11 August 2026 — the slot itself. */
const AT_THE_SLOT = Date.UTC(2026, 7, 11, 11, 45);
/** 09:30 CDT the same day: late, and still inside the grace window. */
const LATE_BUT_STILL_MORNING = Date.UTC(2026, 7, 11, 14, 30);
/** 06:45 CDT the next day. */
const NEXT_MORNING = AT_THE_SLOT + 24 * 60 * 60_000;

const databases: SylDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function store(): JobStore {
  const db = testDatabase();
  databases.push(db);
  return new JobStore({ db: db.handle });
}

/** A turn that said something and called the tools it is given. */
function said(text: string, tools: readonly string[] = []): TurnResult {
  return {
    sessionId: "sess-agenda",
    text,
    spoken: text,
    costUsd: 0.02,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId: "sess-agenda",
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
      sessionId: "sess-agenda",
      raw: {},
      name,
      input: {},
    })),
  };
}

interface Recorder extends AgendaVoice {
  readonly prompts: string[];
  readonly resets: number[];
}

/** A stand-in for the agenda lane that records what it was asked. */
function voice(answer: TurnResult | (() => Promise<TurnResult>) = said("Composed.")): Recorder {
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

/** The context the runner hands a handler, for a pass starting now. */
function contextFor(jobs: JobStore, job: Job, now: number, late = false): JobContext {
  const run = jobs.startRun(job, instant(now), now);
  return { job, run, triggerInstant: instant(now), late, now };
}

describe("when the brief is composed", () => {
  it("should compose it BEFORE the note that announces it, never after", () => {
    // The defect this job exists for, as one assertion. His 07:00 note says his
    // objectives are ready; a brief composed at 07:30 makes that note a lie
    // every single morning, and nobody would ever see why.
    expect(agendaWallTime() < ANNOUNCEMENT_WALL_TIME).toBe(true);
    expect(MORNING_AGENDA_WALL_TIME).toBe(agendaWallTime());
  });

  it("should leave the turn long enough to finish before the note fires", () => {
    // The ordering is only real if a SLOW morning also lands in time. The lead
    // is the whole margin the turn has, so the job's wall-clock budget cannot
    // exceed it — otherwise a turn that runs to its own limit is still thinking
    // when the announcement arrives.
    const job = defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.budget.maxWallClockMs).toBeLessThanOrEqual(COMPOSE_LEAD_MS);
    expect(COMPOSE_LEAD_MS).toBeGreaterThan(0);
  });

  it("should be a wall time in his zone, stored as a place and never as an offset", () => {
    // Constraint 5. An offset drifts an hour at every DST boundary, which would
    // move the brief to the wrong side of the announcement twice a year.
    const job = defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.trigger.type).toBe("wall_clock");
    expect(job.trigger.wallTime).toBe(MORNING_AGENDA_WALL_TIME);
    expect(job.trigger.tz).toBe(TZ);
    expect(job.trigger.tz).toContain("/");
  });
});

describe("defineMorningAgendaJob", () => {
  it("should still be worth running a bit late, and not at all much later", () => {
    // `deliver-reminders.ts` already decided this for the rhythm messages it
    // delivers: a morning agenda that arrives at 10:00 is still a morning
    // agenda, and one that arrives at 16:00 is an interruption about a morning
    // that already happened. The same number, imported rather than re-chosen.
    const job = defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.catchUp.policy).toBe("grace_window");
    expect(job.catchUp.graceMs).toBe(RHYTHM_GRACE_MS);
  });

  it("should never compose two briefs for one morning", () => {
    // There is nothing to resume in a brief and nothing worth writing twice.
    expect(defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET }).deliveryClass).toBe(
      "at_most_once",
    );
  });

  it("should outrank the hour that is hers and still yield to him and to a reminder", () => {
    // `scheduled`, not `background`. The hourly self-ping is spare time and may
    // wait; the morning brief is a fixed slot in his rhythm that a note at
    // 07:00 is already announcing. It still sorts below `interactive` and
    // `reminder`, so it can never displace him or a commitment.
    expect(defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET }).priority).toBe("scheduled");
  });

  it("should declare the hands it is actually given, rather than claiming none", () => {
    // The agenda lane is the second widening of `LANES_WITH_HANDS`, and for the
    // plainest possible reason: a brief she cannot file is a brief that exists
    // only in a run record nobody reads. Derived from the server so the
    // catalogue cannot claim a verb she does not have.
    const job = defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.budget.allowedTools).toEqual(advertisedToolNames().map(mcpToolName));
  });

  it("should speak, and spend one turn doing it", () => {
    const job = defineMorningAgendaJob(store(), { tz: TZ, quiet: QUIET });

    expect(job.speaks).toBe(true);
    expect(job.budget.maxTurns).toBe(1);
  });
});

describe("ensureMorningAgendaJob", () => {
  it("should create exactly one, and then find the one it created", () => {
    // `nextRunAt` is state. Redefining the row on every boot would throw it
    // away along with the circuit breaker.
    const jobs = store();

    const first = ensureMorningAgendaJob(jobs, { tz: TZ, quiet: QUIET }, AT_THE_SLOT);
    const second = ensureMorningAgendaJob(jobs, { tz: TZ, quiet: QUIET }, AT_THE_SLOT + 5_000);

    expect(second.id).toBe(first.id);
    expect(jobs.list({ kind: "morning_agenda", limit: 10 }).items).toHaveLength(1);
  });

  it("should schedule the next slot from the runner's clock, not the store's", () => {
    // A service that boots at 09:00 composes tomorrow's brief tomorrow, and one
    // that boots at 03:00 composes today's at 06:45. Both are the next
    // occurrence strictly after the instant the runner leased from.
    const jobs = store();

    const afterBreakfast = ensureMorningAgendaJob(
      jobs,
      { tz: TZ, quiet: QUIET },
      LATE_BUT_STILL_MORNING,
    );

    expect(afterBreakfast.nextRunAt).toBe(instant(NEXT_MORNING));
  });
});

describe("PUTS_IT_IN_FRONT_OF_HIM", () => {
  it("should name only verbs that actually exist on her hands", () => {
    // The guard against the set rotting into a list of phantoms: a rename in
    // `tools/schemas.ts` would otherwise leave every morning recorded as one
    // where she filed nothing, silently.
    for (const verb of PUTS_IT_IN_FRONT_OF_HIM) {
      expect(advertisedToolNames(), `${verb} is not a verb she has`).toContain(verb);
    }
    expect(PUTS_IT_IN_FRONT_OF_HIM.length).toBeGreaterThan(0);
  });
});

describe("the prompt she is woken with", () => {
  const moment = {
    now: AT_THE_SLOT,
    tz: TZ,
    quiet: QUIET,
    announcedAt: ANNOUNCEMENT_WALL_TIME,
    inQuietHours: true,
    late: false,
  };

  it("should tell her the morning, in his zone and never as an offset", () => {
    const prompt = agendaPrompt(moment);

    expect(prompt).toContain(TZ);
    expect(prompt).toContain("06:45");
    expect(prompt).not.toMatch(/UTC[+-]\d/);
  });

  it("should say the note that announces the brief is already scheduled", () => {
    // The reason this turn is early rather than punctual. Without it she has no
    // way to know the brief is being announced to him by something else.
    expect(agendaPrompt(moment)).toContain(ANNOUNCEMENT_WALL_TIME);
  });

  it("should point her at the verb that shows her his day", () => {
    // Not a prompt stuffed with his data — the verb she already has. A turn
    // that looks is better than a turn that is told, and a told turn goes stale
    // between the moment the prompt is built and the moment she reads it.
    const prompt = agendaPrompt(moment);

    expect(prompt).toContain("whats_outstanding");
    expect(prompt.toLowerCase()).toContain("reminders");
    expect(prompt.toLowerCase()).toContain("to-dos");
    expect(prompt.toLowerCase()).toContain("goals");
  });

  it("should tell her to put the brief somewhere he will actually find it", () => {
    // The turn's return value goes to a run record. If she only answers, the
    // brief does not exist, which is the defect this job was built for.
    expect(agendaPrompt(moment).toLowerCase()).toMatch(/hands|file|put it in front of him/);
  });

  it("should say that what she says here does not reach him", () => {
    expect(agendaPrompt(moment).toLowerCase()).toMatch(/not sent to him|is written down/);
  });

  it("should let a quiet morning be a short brief rather than an invented one", () => {
    // `SOUL.md`: notice, do not nag. A daily slot is exactly where an assistant
    // learns to manufacture content, and a manufactured brief is how the whole
    // rhythm gets muted.
    expect(agendaPrompt(moment).toLowerCase()).toMatch(/short|little|nothing/);
  });

  it("should say he is asleep, and when he will actually see it", () => {
    // 06:45 is inside a 22:00-08:00 window. She should not be surprised that
    // nothing arrives on his phone for another hour and a quarter.
    const prompt = agendaPrompt(moment);

    expect(prompt.toLowerCase()).toMatch(/asleep|sleep/);
    expect(prompt).toContain(QUIET.end);
  });

  it("should say so when the morning is already half gone", () => {
    // A brief composed at 09:30 that opens "good morning, here is your day"
    // reads as a machine that did not notice it was late.
    const prompt = agendaPrompt({
      ...moment,
      now: LATE_BUT_STILL_MORNING,
      inQuietHours: false,
      late: true,
    });

    expect(prompt.toLowerCase()).toContain("late");
    expect(prompt).toContain("09:30");
  });
});

describe("the morning itself", () => {
  function ready(now = AT_THE_SLOT): { readonly jobs: JobStore; readonly job: Job } {
    const jobs = store();
    const job = ensureMorningAgendaJob(jobs, { tz: TZ, quiet: QUIET }, now);
    return { jobs, job };
  }

  it("should wake her once, with the prompt", async () => {
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createMorningAgendaHandler({ voice: heard, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, AT_THE_SLOT));

    expect(heard.prompts).toHaveLength(1);
    expect(heard.prompts[0]).toContain(TZ);
  });

  it("should record a morning she filed the brief on as one that reached him", async () => {
    const { jobs, job } = ready();
    const handler = createMorningAgendaHandler({
      voice: voice(said("Three things today.", [mcpToolName("remind_me")])),
      tz: TZ,
      quiet: QUIET,
    });

    const result = await handler(contextFor(jobs, job, AT_THE_SLOT));

    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(true);
    expect(result.summary).toContain("Three things today");
  });

  it("should not mistake looking at his day for composing a brief", async () => {
    // `whats_outstanding` is the read the prompt sends her to. A morning that
    // only read is a morning with no brief in it.
    const { jobs, job } = ready();
    const handler = createMorningAgendaHandler({
      voice: voice(said("Had a look.", [mcpToolName("whats_outstanding")])),
      tz: TZ,
      quiet: QUIET,
    });

    expect((await handler(contextFor(jobs, job, AT_THE_SLOT))).spoke).toBe(false);
  });

  it("should be loud in the log about a morning that produced no brief", async () => {
    // Not a failure — a failed morning walks the circuit breaker towards open
    // and would eventually take the rhythm away, which is the defect coming
    // back by a different door. It is recorded and said out loud instead.
    const { jobs, job } = ready();
    const lines: Array<{ level: string; event: string }> = [];
    const handler = createMorningAgendaHandler({
      voice: voice(said("Nothing to say.")),
      tz: TZ,
      quiet: QUIET,
      log: {
        log: (level, event) => {
          lines.push({ level, event });
        },
      },
    });

    const result = await handler(contextFor(jobs, job, AT_THE_SLOT));

    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(false);
    expect(lines.some((line) => line.event === "agenda.composed_nothing")).toBe(true);
  });

  it("should start each morning on a fresh thread", async () => {
    // A brief is a day's work, and the days are not one conversation. Left to
    // resume, the lane would carry every previous morning's transcript into
    // every later one, on the rate-limit pool she shares with him.
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createMorningAgendaHandler({ voice: heard, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, AT_THE_SLOT));
    await handler(contextFor(jobs, job, NEXT_MORNING));

    expect(heard.resets).toHaveLength(2);
  });

  it("should be silent to him and loud in the log when the turn dies", async () => {
    const { jobs, job } = ready();
    const lines: string[] = [];
    const handler = createMorningAgendaHandler({
      voice: voice(() => Promise.reject(new Error("claude exited 1"))),
      tz: TZ,
      quiet: QUIET,
      log: {
        log: (level) => {
          lines.push(level);
        },
      },
    });

    const result = await handler(contextFor(jobs, job, AT_THE_SLOT));

    expect(result.outcome).toBe("failure");
    expect(result.spoke).toBe(false);
    expect(result.error).toContain("claude exited 1");
    expect(lines).toContain("error");
  });

  it("should never unschedule itself, however badly the morning went", async () => {
    // `nextRunAt: null` takes a job out of `due` forever, which is the exact
    // shape of a rhythm that silently stops.
    const { jobs, job } = ready();
    const handler = createMorningAgendaHandler({
      voice: voice(() => Promise.reject(new Error("boom"))),
      tz: TZ,
      quiet: QUIET,
    });

    expect((await handler(contextFor(jobs, job, AT_THE_SLOT))).nextRunAt).toBeUndefined();
  });

  it("should not throw when the turn does, so one bad morning cannot stop the loop", async () => {
    const { jobs, job } = ready();
    const handler = createMorningAgendaHandler({
      voice: voice(() => Promise.reject("a string, thrown")),
      tz: TZ,
      quiet: QUIET,
    });

    await expect(handler(contextFor(jobs, job, AT_THE_SLOT))).resolves.toBeDefined();
  });

  it("should tell her it is late when the runner says the slot was missed", async () => {
    const { jobs, job } = ready();
    const heard = voice();
    const handler = createMorningAgendaHandler({ voice: heard, tz: TZ, quiet: QUIET });

    await handler(contextFor(jobs, job, LATE_BUT_STILL_MORNING, true));

    expect(heard.prompts[0]?.toLowerCase()).toContain("late");
  });
});

describe("describeAgenda", () => {
  it("should say when the brief is composed, in his zone, and when it next runs", () => {
    const jobs = store();
    const job = ensureMorningAgendaJob(jobs, { tz: TZ, quiet: QUIET }, AT_THE_SLOT);

    const [line] = describeAgenda(job, { tz: TZ, quiet: QUIET });

    expect(line).toContain(TZ);
    expect(line).toContain(MORNING_AGENDA_WALL_TIME);
    expect(line).toContain(ANNOUNCEMENT_WALL_TIME);
    expect(describeAgenda(job, { tz: TZ, quiet: QUIET })).toHaveLength(1);
  });
});
