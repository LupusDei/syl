import { afterEach, describe, expect, it } from "vitest";

import type { QuietHours } from "../../src/harness/schedule.js";
import type { TurnResult } from "../../src/harness/session.js";
import {
  agendaPrompt,
  AGENDA_PROMPT_MAX_BYTES,
  agendaPromptBytes,
  ANNOUNCEMENT_WALL_TIME,
  createMorningAgendaHandler,
  ensureMorningAgendaJob,
  prunedHisList,
  TAKES_SOMETHING_OFF_HIS_LIST,
  type AgendaVoice,
} from "../../src/jobs/agenda-job.js";
import { instant } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { JobContext } from "../../src/services/job-runner.js";
import { JobStore } from "../../src/services/job-store.js";
import { mcpToolName } from "../../src/tools/config.js";
import { advertisedToolNames } from "../../src/tools/server.js";
import { testDatabase } from "../helpers/service.js";

/**
 * The morning brief PLANS the day (`syl-agd.3`).
 *
 * The Commander's words, and they are the specification: *"the morning review
 * should prepare the day. It should look at all the todos reminders and the
 * goals. It should then try and consolidate and plan out the best order of
 * operations and the best approach to accomplish it all and prioritize and
 * figure out what's at risk of not getting done."*
 *
 * Five things. The brief already triaged well — *"Ten things are dated for
 * today and only three of them are real"* — so four of the five were partly
 * there. **Nothing did the fifth.** A brief that lists his day back in a better
 * order is worth something; one that says *these two will not both happen and
 * here is which to drop* is worth much more, and that is the sentence he will
 * judge this by.
 *
 * ## The half of this that is a guard, not a feature
 *
 * Consolidating and prioritising both mean touching his list, and constraint 6
 * governs: **the system does not silently discard.** Merging two to-dos
 * destroys one of them. So the plan lives in the BRIEF — she says what she
 * would merge and he merges it — and the only writes she makes are ones the
 * brief itself names. Half the assertions below are about what she may not do,
 * and they are the reason this file exists at all.
 *
 * ## Why it is not in `agenda-job.test.ts`
 *
 * The ordering that job turns on — the brief exists before the note announcing
 * it — is a different property from what the brief CONTAINS, and it is tested
 * beside the schedule constants it depends on. Keeping the planning assertions
 * here also keeps two live branches out of each other's way: the quiet-hours
 * window is being changed in `agenda-job.test.ts` at the same time as this.
 */

const TZ = "America/Chicago";
const QUIET: QuietHours = { start: "22:00", end: "08:00" };

/** 06:45 CDT on Tuesday 11 August 2026 — the slot itself. */
const AT_THE_SLOT = Date.UTC(2026, 7, 11, 11, 45);

const MOMENT = {
  now: AT_THE_SLOT,
  tz: TZ,
  quiet: QUIET,
  announcedAt: ANNOUNCEMENT_WALL_TIME,
  inQuietHours: true,
  late: false,
} as const;

/** The prompt, lower-cased, which is how every assertion here reads it. */
function prompt(): string {
  return agendaPrompt(MOMENT).toLowerCase();
}

/** A turn that said something and called the verbs it is given. */
function said(text: string, tools: readonly string[] = []): TurnResult {
  return {
    sessionId: "sess-agenda",
    text,
    spoken: text,
    costUsd: 0.02,
    numTurns: 1,
    contextTokens: 0,
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

function voice(answer: TurnResult): AgendaVoice {
  return { ask: async () => Promise.resolve(answer) };
}

const databases: SylDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** A store, a job and the context one morning's pass runs in. */
function morning(): JobContext {
  const db = testDatabase();
  databases.push(db);
  const jobs = new JobStore({ db: db.handle });
  const job = ensureMorningAgendaJob(jobs, { tz: TZ, quiet: QUIET }, AT_THE_SLOT);
  const run = jobs.startRun(job, instant(AT_THE_SLOT), AT_THE_SLOT);
  return { job, run, triggerInstant: instant(AT_THE_SLOT), late: false, now: AT_THE_SLOT };
}

describe("the morning brief reads all of it", () => {
  it("should send her to look at every list, in one call, rather than at the to-dos alone", () => {
    // He said "all the todos reminders and the goals". `whats_outstanding`
    // takes an `of`, and its default when the filter is not one of the three is
    // `everything` — but a default is not an instruction, and a turn told to
    // "look at his day" reaches for the to-dos. Naming the argument is what
    // makes reading the goals part of the morning rather than an option.
    expect(prompt()).toContain("whats_outstanding");
    expect(prompt()).toContain("everything");
  });

  it("should say what the goals are FOR, so the ranking is defensible rather than a guess", () => {
    // The goals are the only thing that makes one item outrank another for a
    // reason he can argue with. A brief that prioritises without naming them is
    // asserting a preference and calling it a plan.
    expect(prompt()).toMatch(/goals? are what|makes an order|arbitrary|defensible/);
  });
});

describe("the morning brief consolidates without destroying anything", () => {
  it("should have her NAME a duplicate rather than merge it", () => {
    // Constraint 6's spirit and the whole guard: merging two of his to-dos
    // destroys one. She proposes; he decides.
    expect(prompt()).toContain("merge");
    expect(prompt()).toMatch(/do not perform it|propose|his call, not yours/);
  });

  it("should say plainly that nothing comes off his list this morning", () => {
    // Finishing, dropping and cancelling are the three verbs whose effect is
    // that something he had is no longer there. A planning turn has no business
    // with any of them: if she is wrong, the item is gone and he never learns
    // it existed, which is the silent discard constraint 4 forbids.
    expect(prompt()).toMatch(/nothing comes off|do not finish|do not drop|do not cancel/);
  });

  it("should require every change she DOES make to appear in the brief that made it", () => {
    // The concession, and its price. Scheduling is a safe write, so she may
    // schedule — but he must never open his list and find it rearranged by
    // something he did not watch. A move he is not told about is a move that
    // reads as his own memory failing.
    expect(prompt()).toMatch(/say, in the brief|every change you made|find it rearranged/);
  });
});

describe("the morning brief orders and prioritises", () => {
  it("should anchor the order on the things with an hour on them", () => {
    // A call at 08:00 is a wall, not a preference. The rest of the day is
    // built around the fixed points or the sequence is fiction.
    expect(prompt()).toMatch(/fixed point/);
  });

  it("should ask for a sequence with reasons, because the reasons are the plan", () => {
    // `SOUL.md`: the reason travels with the thing or he cannot tell a good
    // suggestion from a wrong one. A reordered list with no reasons is a
    // rearrangement he has to take on trust.
    expect(prompt()).toMatch(/why each|the reasons are the plan|sequence/);
  });

  it("should rank a thing that serves a goal above one that does not, and say which goal", () => {
    expect(prompt()).toMatch(/outranks/);
    expect(prompt()).toMatch(/which goal/);
  });
});

describe("what is at risk of not getting done", () => {
  it("should demand the item, the reason and the move — not a hedge", () => {
    // The sentence he will judge this by, and the easiest one in the brief to
    // soften into uselessness. "It might be tight" is not a warning; "the
    // Saim City shoot will not fit behind the prod push, move it to Thursday"
    // is. `SOUL.md`: a deadline at risk gets said plainly and early, never
    // softened into a suggestion.
    const text = prompt();

    expect(text).toContain("at risk");
    expect(text).toMatch(/name the item/);
    expect(text).toMatch(/will not fit|why it will not/);
    expect(text).toMatch(/drop it, move it|what to do about it/);
  });

  it("should refuse the hedge by name, so the softened version is not available", () => {
    expect(prompt()).toMatch(/tight|a warning he cannot act on/);
  });

  it("should let a morning with nothing at risk say exactly that", () => {
    // The failure mode of asking this question every single day. An assistant
    // asked "what is at risk" each morning will find something, and a risk
    // invented because the hour came round teaches him to ignore the real one
    // — which costs more than never having asked.
    expect(prompt()).toMatch(/if nothing is at risk|nothing is at risk, say/);
  });
});

describe("the brief stays a brief", () => {
  it("should ask for one brief rather than five headings", () => {
    // Five things to do is not five sections to write. `SOUL.md`: an assistant
    // that speaks constantly gets muted, and a muted assistant is useless.
    expect(prompt()).toMatch(/not five headings|one brief/);
  });

  it("should cost the turn less than the ceiling this prompt is budgeted at", () => {
    // Every sentence added here is paid on every morning forever, and this is
    // the file where prose grows. The ceiling is a tripwire on a prompt that
    // has run away, not a token economy — but it is measured rather than
    // assumed, which is the thing that was missing when the system prompt
    // quietly ate its own margin twice in one day.
    expect(agendaPromptBytes(MOMENT)).toBeLessThan(AGENDA_PROMPT_MAX_BYTES);
  });
});

describe("TAKES_SOMETHING_OFF_HIS_LIST", () => {
  it("should name only verbs she actually has", () => {
    // The same guard `PUTS_IT_IN_FRONT_OF_HIM` carries: a rename in
    // `tools/schemas.ts` would otherwise leave this watching for a phantom and
    // reporting every morning as clean.
    for (const verb of TAKES_SOMETHING_OFF_HIS_LIST) {
      expect(advertisedToolNames(), `${verb} is not a verb she has`).toContain(verb);
    }
    expect(TAKES_SOMETHING_OFF_HIS_LIST.length).toBeGreaterThan(0);
  });

  it("should recognise the verb under either spelling", () => {
    // A real transcript carries `mcp__syl__drop_todo`; a hand-written fixture
    // carries `drop_todo`. Both mean an item left his list.
    expect(prunedHisList(said("done", [mcpToolName("drop_todo")]).events)).toEqual(["drop_todo"]);
    expect(prunedHisList(said("done", ["finish_todo"]).events)).toEqual(["finish_todo"]);
  });

  it("should not report a morning that only planned", () => {
    expect(
      prunedHisList(
        said("planned", [mcpToolName("whats_outstanding"), mcpToolName("schedule_todo")]).events,
      ),
    ).toEqual([]);
  });
});

describe("a morning that pruned his list anyway", () => {
  it("should be loud in the log, naming what left the list", async () => {
    // The prompt is an instruction and instructions are not guarantees. Nothing
    // in the harness can stop this turn using a verb it has, so the guarantee
    // that is actually available is that it cannot happen QUIETLY: the operator
    // sees which verb ran on the morning it ran.
    const lines: Array<{ level: string; event: string; fields?: unknown }> = [];
    const handler = createMorningAgendaHandler({
      voice: voice(said("Tidied up.", [mcpToolName("remind_me"), mcpToolName("drop_todo")])),
      tz: TZ,
      quiet: QUIET,
      log: {
        log: (level, event, fields) => {
          lines.push({ level, event, fields });
        },
      },
    });

    const result = await handler(morning());

    const pruned = lines.find((line) => line.event === "agenda.pruned");
    expect(pruned).toBeDefined();
    expect(pruned?.level).toBe("warn");
    expect(JSON.stringify(pruned?.fields)).toContain("drop_todo");
    // Still a success and still a brief. Recording it as a failure would walk
    // the circuit breaker towards open and take the whole rhythm away over a
    // question of manners.
    expect(result.outcome).toBe("success");
    expect(result.spoke).toBe(true);
  });

  it("should say nothing at all about a morning that planned and scheduled", async () => {
    const lines: string[] = [];
    const handler = createMorningAgendaHandler({
      voice: voice(said("Four things.", [mcpToolName("schedule_todo"), mcpToolName("remind_me")])),
      tz: TZ,
      quiet: QUIET,
      log: {
        log: (_level, event) => {
          lines.push(event);
        },
      },
    });

    await handler(morning());

    expect(lines).not.toContain("agenda.pruned");
  });
});
