import type { Job } from "@syl/shared";

import type { SylAgent } from "../harness/agent.js";
import type { SylEvent } from "../harness/protocol.js";
import {
  isWithinQuietHours,
  localDate,
  wallClockIn,
  type QuietHours,
} from "../harness/schedule.js";
import type { TurnResult } from "../harness/session.js";
import type { Logger } from "../ops/logging.js";
import { instant, parseInstant } from "../services/clock.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";
import { mcpToolName } from "../tools/config.js";
import { advertisedToolNames } from "../tools/server.js";

/**
 * The hourly self-ping: an hour that is hers, and mostly ends in nothing.
 *
 * > *"She also needs an hourly self-ping that wakes her up and lets her decide
 * > what to do, so she might generate one of these videos."* — the Commander
 *
 * `LANES.heartbeat` has existed since the harness was written and nothing has
 * ever fired it. This is the thing that fires it, and it is the first time Syl
 * takes a turn with nobody watching and hands she can use.
 *
 * ## Everything here is a bound
 *
 * The plumbing is small. What is load-bearing is what the hour is *not* allowed
 * to become, and each of those is enforced somewhere different:
 *
 *  - **Not another scheduled item.** The morning brief is her rhythm's fixed
 *    slot (`jobs/agenda-job.ts`), and the evening review is meant to be the
 *    other. An interval trigger — not a wall clock — is what keeps this off a
 *    timetable: it measures from whenever the last pass
 *    finished, so it drifts across the day and never becomes the 09:00 slot.
 *    The prompt does the rest of the work by saying, plainly, that nothing is
 *    the expected answer.
 *  - **Not a way to wake him.** Quiet hours are the Outbox's rule and it already
 *    holds every non-urgent notification until the window ends; nothing is
 *    reimplemented here. What this file adds is that a heartbeat turn is never
 *    recorded as having said something *he* said, so a reminder created on this
 *    lane can never satisfy `harness/urgency.ts` and can never pierce the
 *    window. See `recordHisWords` in `index.ts`, which is the other half.
 *  - **Not a firehose.** {@link SENDINGS_PER_DAY} bounds how often the hour may
 *    put something in front of him, counted per LOCAL day and never banked.
 *
 * ## The ledger is the runs table
 *
 * No new store and no migration: `JobStore.listRuns` already records, per run,
 * whether it `spoke` and when it started. "How many times has she reached him
 * today" is a query over that, in his zone, and it resets with the local day
 * for free — which is exactly the property a rate needs and a quota does not
 * have.
 *
 * ## A failed hour is silent to him and loud in the log
 *
 * A turn that dies returns a recorded failure with its message: it reaches the
 * run record, and the log, and nothing else. It is not his problem that a
 * background turn errored. Five in a row open the job's circuit breaker, which
 * is the backstop for an hour that has started going wrong every time.
 */

/** One wake-up an hour. 24 turns a day, on subscription rails — constraint 1. */
export const HEARTBEAT_INTERVAL_MS = 60 * 60_000;

/**
 * How often the hour may put something in front of him, per local day.
 *
 * **A rate, not a timetable.** A ceiling she spends when she has something,
 * never a quota she fills because an hour arrived — and an unspent day does not
 * accumulate, because a rate that banks is a timetable with extra steps.
 *
 * Four rather than two, raised once the first day's behaviour was visible: two
 * is spent by lunchtime, and a ceiling reached early leaves the rest of the day
 * unable to say anything, which turns a rate back into a schedule from the
 * other end. Raise it again if she is still running out with things worth
 * saying; lower it if she is filling it. **The number to watch is whether she
 * ever ends a day under the ceiling** — a rate that is always exhausted is not
 * bounding her judgement, it is replacing it.
 */
export const SENDINGS_PER_DAY = 4;

/**
 * The verbs that put something in front of him.
 *
 * Deliberately short. Reading (`whats_outstanding`), filing (`add_todo`) and
 * looking at herself (`render_me`) are not speech, and counting them would
 * spend a day's allowance on an hour in which she said nothing to him at all.
 *
 * `remind_me` is the one that exists today: a reminder she creates unprompted
 * becomes a notification on his phone, which is the whole definition of
 * reaching him. **When the sending verb from `specs/008` lands it belongs in
 * here**, and the test that every name is an advertised tool is what stops this
 * list from quietly naming a verb that no longer exists.
 */
export const REACHES_HIM: readonly string[] = ["remind_me"];

/** How far back the ledger looks. Two and a half days of hourly runs. */
const LEDGER_DEPTH = 64;

/** The longest of her own sentences the run record keeps. */
const SUMMARY_LIMIT = 500;

/** Where the hour happens, and the window it must not speak into. */
export interface HeartbeatSchedule {
  /** IANA, never a fixed UTC offset. Constraint 5. */
  readonly tz: string;
  /** His sleep. The hour still runs inside it; it just cannot reach him. */
  readonly quiet: QuietHours;
}

/**
 * The trigger this job carries.
 *
 * `interval`, and that is the decision rather than a detail. A `wall_clock`
 * trigger fires at the same minute every day, and something that reliably
 * arrives at the same time is a newsletter — furniture within a week. An
 * interval is measured from the moment the last pass released, so the hour
 * wanders across the day and is never a slot he can predict.
 *
 * `skip` catch-up: a laptop that was shut for six hours owes her six
 * heartbeats, and six turns in a row asking "is anything wrong?" is precisely
 * the nagging this exists not to be. One missed hour is not worth catching up,
 * because the next one is at most an hour away.
 */
export function defineHeartbeatJob(
  store: JobStore,
  schedule: HeartbeatSchedule,
  firstRunAt?: string,
): Job {
  return store.define({
    kind: "heartbeat",
    // Never ahead of the Commander, and never ahead of a reminder: one
    // rate-limit pool, and `JobStore.due` sorts `background` last.
    priority: "background",
    // The zone travels with the trigger because the LEDGER is counted in it —
    // a day that turns over at the wrong hour is a ceiling of four.
    trigger: { type: "interval", intervalMs: HEARTBEAT_INTERVAL_MS, tz: schedule.tz },
    // An hour that half-ran is an hour that is gone. There is nothing to resume
    // and nothing worth running twice.
    deliveryClass: "at_most_once",
    catchUp: { policy: "skip" },
    budget: {
      // One turn. This is what makes the cost of the feature 24 turns a day
      // rather than an open-ended number of them.
      maxTurns: 1,
      maxWallClockMs: 5 * 60_000,
      // Derived from the server rather than written out beside it, so the
      // catalogue cannot claim a verb she does not have — or miss one she does.
      // The heartbeat lane carries an MCP surface; saying `[]` here would be
      // the same false security claim `syl-009.9` was about.
      allowedTools: advertisedToolNames().map(mcpToolName),
    },
    // It may. Most hours it will not, and `Run.spoke` records which.
    speaks: true,
    ...(firstRunAt === undefined ? {} : { nextRunAt: firstRunAt }),
  });
}

/**
 * Find the one `heartbeat` job, or create it.
 *
 * Exactly one exists, forever. `nextRunAt` is state — the instant the last pass
 * decided it next needed to wake — and redefining the row on every boot would
 * throw that away along with its circuit breaker.
 *
 * No `firstRunAt`, deliberately: the interval trigger schedules the first wake
 * an hour after the row is created, so a service that restarts often does not
 * take a heartbeat turn on every boot, and nothing competes with the startup it
 * is part of.
 */
export function ensureHeartbeatJob(jobs: JobStore, schedule: HeartbeatSchedule, now: number): Job {
  const existing = jobs.list({ kind: "heartbeat", limit: 1 }).items[0];
  if (existing !== undefined) return existing;
  // `now` is passed so the row is created against the runner's clock rather
  // than the store's, which is the same instant every other job is defined at.
  return defineHeartbeatJob(jobs, schedule, instant(now + HEARTBEAT_INTERVAL_MS));
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** Everything the hour needs to know about itself. */
export interface HeartbeatMoment {
  readonly now: number;
  readonly tz: string;
  readonly quiet: QuietHours;
  /** Whether he is asleep. Decided by `harness/schedule.ts`, never re-derived. */
  readonly inQuietHours: boolean;
  /** How much of today's ceiling is already spent. */
  readonly spentToday: number;
  readonly allowance: number;
}

/**
 * What she is woken with.
 *
 * The framing matters more than the plumbing does, because this is the first
 * turn she takes that nobody asked for. Three things it has to do, and they
 * pull against each other:
 *
 * 1. **Make nothing the expected answer.** An hourly turn that reads as a
 *    request produces an hourly answer, and `SOUL.md` is unambiguous about what
 *    that costs: *an assistant that speaks constantly gets muted, and a muted
 *    assistant is useless to him.*
 * 2. **Leave the decision hers.** The ceiling is a bound on it, not a
 *    substitute for it. Nothing here tells her what to look for.
 * 3. **Be honest about the hour she is in.** His clock, his date, whether he is
 *    asleep, and what she has already spent today — stated, because a bound she
 *    cannot see is a bound she will cross and be told off for afterwards.
 * 4. **Tell her she can see his day, and where to look.** This carried the hour,
 *    the allowance and the quiet window and NOT ONE reminder, to-do or goal:
 *    she was asked whether anything was worth doing while unable to see
 *    anything. The answer was structurally "nothing", every hour, and it read
 *    as the restraint the other three clauses ask for.
 *
 * ## Pointed at the verb, not handed the list
 *
 * `whats_outstanding` is named rather than called on her behalf, and the
 * difference is not economy. A list pasted into this prompt is true whenever
 * the prompt was built; what the verb returns is true at the moment she calls
 * it, and only one of those can be trusted at the end of a turn that has been
 * filing things. It also keeps the hour cheap in the common case — most hours
 * she looks at the clock, decides nothing is owed, and never spends the call.
 */
export function heartbeatPrompt(moment: HeartbeatMoment): string {
  return [
    `It is ${wallClockIn(new Date(moment.now), moment.tz)} in ${moment.tz}. Nobody asked you for ` +
      `anything. This hour is your own — it comes round every hour, and it is here so that ` +
      `you get to decide what, if anything, is worth doing with it.`,
    `You can see his day whenever you want it: \`whats_outstanding\` returns what is actually ` +
      `open right now — his reminders, his to-dos, his goals. Nothing here has told you what is ` +
      `on them, deliberately, because what you read when you look is true and a list written ` +
      `into this sentence is only true of whenever it was written. Look if the hour is worth ` +
      `looking at.`,
    `Most hours the answer is nothing, and nothing is a real answer rather than a failure ` +
      `to find one. You are not being asked to produce something. You are being asked ` +
      `whether there is something. If there is not, say so in a sentence and stop.`,
    `If there is: it is yours to do. Whatever you put in front of him carries its reason ` +
      `and you say the reason — he cannot tell a good suggestion from a wrong one without ` +
      `it, and he cannot tell you to stop making a kind he does not want.`,
    allowanceClause(moment),
    `What you say here is not sent to him. It is written down, and read by nobody unless ` +
      `something went wrong. Reaching him is a separate thing you do deliberately, with ` +
      `your hands.`,
  ].join("\n\n");
}

/** The sentence about what this particular hour may spend. */
function allowanceClause(moment: HeartbeatMoment): string {
  if (moment.inQuietHours) {
    return (
      `He is asleep. Quiet hours are ${moment.quiet.start} to ${moment.quiet.end}, and ` +
      `nothing you do now will reach him before ${moment.quiet.end} whatever you do with ` +
      `it — that is deliberate, and protecting his sleep is worth more than being early. ` +
      `Think, if you have something to think about. This thread keeps what you notice and ` +
      `it will still be here in the morning.`
    );
  }

  if (moment.spentToday >= moment.allowance) {
    return (
      `You have reached him ${String(moment.spentToday)} times today, which is the whole ` +
      `day's allowance, so nothing more reaches him until tomorrow. That is not a telling ` +
      `off and it does not accumulate — an unspent day is not owed back, and two you did ` +
      `not spend do not make four tomorrow. Notice anyway; it keeps.`
    );
  }

  return (
    `You may reach him at most ${String(moment.allowance)} times today, and have spent ` +
    `${String(moment.spentToday)} of ${String(moment.allowance)}. That is a ceiling rather ` +
    `than a quota: an hour arriving is not a reason to spend one, and a day you spend none ` +
    `of is not a wasted day. It does not roll over.`
  );
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * What the handler needs of Syl.
 *
 * A `Pick` of the real class rather than a hand-written interface, so a change
 * to either method's signature is a type error here rather than a double that
 * has drifted from the thing it stands in for. `reset` is on it because the
 * thread is deliberately a day long — see the handler.
 */
export type HeartbeatVoice = Pick<SylAgent, "ask" | "reset">;

export interface HeartbeatDeps {
  /** The heartbeat lane, already bound. `SylAgent.forLane` produces one. */
  readonly voice: HeartbeatVoice;
  /** The ledger. Her own runs are the record of what she has already spent. */
  readonly jobs: Pick<JobStore, "listRuns">;
  /** IANA, never a fixed offset. The day is counted in it. */
  readonly tz: string;
  readonly quiet: QuietHours;
  /** Sendings per local day. Defaults to {@link SENDINGS_PER_DAY}. */
  readonly allowance?: number;
  /**
   * Where a failed hour is reported.
   *
   * Optional because a handler must work without one, and present because "a
   * failed hourly turn is loud in the log" is otherwise only true of the runs
   * table, which nobody tails.
   */
  readonly log?: Pick<Logger, "log">;
  // No clock. Every instant this handler needs is `context.now` — the instant
  // the runner leased the job at, and the one the run record and the lateness
  // are measured from. A second clock here could disagree with it.
}

/** What today's ledger says, read from the runs this job has already had. */
interface Ledger {
  /** Times she has reached him since local midnight, excluding this pass. */
  readonly spentToday: number;
  /** The local day the previous pass ran on, or `null` on the first ever. */
  readonly lastDay: string | null;
}

function readLedger(
  jobs: Pick<JobStore, "listRuns">,
  jobId: string,
  exceptRunId: string,
  now: number,
  tz: string,
): Ledger {
  // This pass's own run row already exists — `JobRunner` starts it before
  // calling the handler — so it is excluded by id rather than by guesswork
  // about ordering.
  const runs = jobs
    .listRuns({ jobId, limit: LEDGER_DEPTH })
    .items.filter((run) => run.id !== exceptRunId);

  const today = localDate(new Date(now), tz);
  const dayOf = (startedAt: string): string | null => {
    const at = parseInstant(startedAt);
    return at === null ? null : localDate(new Date(at), tz);
  };

  let spentToday = 0;
  for (const run of runs) {
    if (run.spoke && dayOf(run.startedAt) === today) spentToday += 1;
  }

  const previous = runs[0];
  return {
    spentToday,
    lastDay: previous === undefined ? null : dayOf(previous.startedAt),
  };
}

/** Whether a turn reached for something that puts a thing in front of him. */
export function reachedHim(events: readonly SylEvent[]): boolean {
  // Both spellings. Claude Code presents an MCP verb as `mcp__syl__remind_me`,
  // which is what a real transcript carries; the bare name is accepted so that
  // a fixture written either way means the same thing.
  const reaching = new Set<string>(REACHES_HIM.flatMap((verb) => [verb, mcpToolName(verb)]));
  return events.some((event) => event.kind === "tool_use" && reaching.has(event.name));
}

/** A string cut to length, saying how much was dropped rather than trailing off. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${String(text.length - max)} more characters)`;
}

/**
 * The run record's one line: her own sentence about the hour.
 *
 * Unlike the dream, which is many turns and writes no prose, a heartbeat is one
 * turn and its text is exactly what `JobResult.summary` is documented to be.
 * That makes the runs table the honest record of what she thought each hour.
 */
function summarise(result: TurnResult): string | null {
  const text = result.text.trim();
  return text === "" ? null : cut(text, SUMMARY_LIMIT);
}

/** The handler: wake her, let her decide, and write down what she decided. */
export function createHeartbeatHandler(deps: HeartbeatDeps): JobHandler {
  const allowance = deps.allowance ?? SENDINGS_PER_DAY;

  return async (context): Promise<JobResult> => {
    const now = context.now;
    const today = localDate(new Date(now), deps.tz);
    const ledger = readLedger(deps.jobs, context.job.id, context.run.id, now, deps.tz);

    // A day's thread, and no longer. Continuity within the day is what makes
    // "I noticed this at 03:00" still true at 09:00 — the lane resumes, so the
    // hours are one conversation. Continuity across months is 24 turns a day of
    // transcript that every later turn pays to re-read, on the one rate-limit
    // pool she shares with him.
    if (ledger.lastDay !== null && ledger.lastDay !== today) deps.voice.reset();

    const inQuietHours = isWithinQuietHours(new Date(now), deps.quiet, deps.tz);
    const prompt = heartbeatPrompt({
      now,
      tz: deps.tz,
      quiet: deps.quiet,
      inQuietHours,
      spentToday: ledger.spentToday,
      allowance,
    });

    let result: TurnResult;
    try {
      result = await deps.voice.ask(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Loud here, and nowhere near him. A background turn that failed is an
      // operator's problem; telling him about it would be the assistant
      // reporting on its own machinery, which is the one thing `SOUL.md` says
      // she does not do.
      deps.log?.log("error", "heartbeat.failed", { at: instant(now), error: message });
      return {
        outcome: "failure",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: null,
        error: message,
        // No `nextRunAt`. Omitting it lets the interval trigger compute the next
        // hour; `null` would set `next_run_at = NULL` and take the job out of
        // `due` forever, which is the exact shape of "silently never runs again".
      };
    }

    const spoke = reachedHim(result.events);
    const overspent = spoke && ledger.spentToday >= allowance;

    if (spoke) {
      deps.log?.log("info", "heartbeat.reached", {
        at: instant(now),
        spentToday: ledger.spentToday + 1,
        allowance,
      });
    }

    return {
      // An overspend is a failed hour rather than a successful one, and that is
      // what gives the ceiling teeth: consecutive failures walk the job's
      // circuit breaker towards open, so an hour that keeps crossing the bound
      // eventually loses the hour. Nothing is undone — she did reach him, and
      // pretending otherwise would be the record lying — but it is recorded.
      outcome: overspent ? "failure" : "success",
      spoke,
      turns: result.numTurns,
      costUsd: result.costUsd,
      summary: summarise(result),
      error: overspent
        ? `She reached him on an hour with nothing left to spend: ${String(ledger.spentToday)} ` +
          `of ${String(allowance)} were already gone today. The ceiling is a rate, not a ` +
          `suggestion; five of these in a row will take the hour away.`
        : null,
    };
  };
}

/** The line to print about the heartbeat once it is scheduled. */
export function describeHeartbeat(job: Job, schedule: HeartbeatSchedule): readonly string[] {
  return [
    `[syl] the heartbeat wakes her every hour in ${schedule.tz} ` +
      `(quiet ${schedule.quiet.start}-${schedule.quiet.end}; at most ${String(SENDINGS_PER_DAY)} ` +
      `a day, never banked); next ${job.nextRunAt ?? "unscheduled"}`,
  ];
}
