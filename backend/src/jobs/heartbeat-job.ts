import type { Job, JobKind } from "@syl/shared";

import { LANES, type SylAgent } from "../harness/agent.js";
import {
  compactLane,
  describeCompaction,
  whyNotCompact,
  type LaneContextSizes,
} from "../harness/compaction.js";
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
import { COMPOSE_LEAD_MS } from "./agenda-job.js";

/**
 * The hourly self-ping: an hour that is hers, and mostly ends in nothing.
 *
 * > *"She also needs an hourly self-ping that wakes her up and lets her decide
 * > what to do, so she might generate one of these videos."* — the Commander
 *
 * This is the first turn Syl takes with nobody watching and hands she can use.
 *
 * ## Whose thread the hour happens in
 *
 * His. It ran on a lane of its own until the Commander ruled otherwise on
 * 2026-08-11 — *"there will be things in the chat session that might invoke a
 * reason to send a message and how it should appear — a new lane invalidates
 * that entirely"* — and the argument is kept beside `LANES` in
 * `harness/agent.ts`. Two consequences land in this file: the hour reads what
 * he has been saying, and **nothing here may reset the thread**, because on his
 * lane that is his conversation being deleted.
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
 *    hour can never satisfy `harness/urgency.ts` and can never pierce the
 *    window. That is `AskOptions.hisWords`, which the hour does not set and
 *    cannot; see `recordHisWords` in `index.ts`, which is the other half.
 *    **It is not keyed on the lane** — it was, until the hour moved onto his,
 *    and a protection resting on a lane name would have been repealed by that
 *    move without a word about sleep anywhere in it.
 *  - **Not a reason not to run.** Quiet hours bound what may *reach* him, never
 *    what may happen. The hour still takes its turn at 03:00 and is told he is
 *    asleep; the dream and the morning brief also run inside the window by
 *    design. Anything that starts treating the window as "do not run" takes
 *    those with it.
 *  - **Not a firehose.** {@link SENDINGS_PER_DAY} bounds how often the hour may
 *    put something in front of him, counted per LOCAL day and never banked.
 *  - **Not in anybody's way.** It stands aside for his own turns and for the
 *    scheduled ones that outrank it, at zero cost and without failing. See
 *    {@link OUTRANKS_THE_HOUR}.
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
 * All three of these land on his phone unprompted, which is the whole
 * definition of reaching him: `remind_me` as a notification, `show_him` as a
 * sending in From Syl, `tell_him` as her words in the conversation and on his
 * lock screen. Any future verb that arrives at him without his asking belongs
 * here too, and the test that every name is an advertised tool is what stops
 * this list from quietly naming a verb that no longer exists.
 *
 * A verb missing from this list is not a small error: the hour it is used in
 * is counted as an hour that reached nobody, so `SENDINGS_PER_DAY` bounds
 * nothing and she may speak every hour of the day. It has happened twice —
 * `show_him` sat unlisted for a week (`syl-7ci`), and `tell_him` was added to
 * this line in the same commit that created it (`syl-0x1h`) precisely because
 * of that.
 */
export const REACHES_HIM: readonly string[] = ["remind_me", "show_him", "tell_him"];

/**
 * The job kinds whose runs spend from the day's allowance.
 *
 * **The ceiling is a property of HER, not of one job**, and this list is what
 * keeps that true as the ways she can reach him multiply. The hour used to be
 * the only unattended turn that could put something in front of him, so
 * counting runs of the heartbeat job was the same thing as counting how often
 * she had reached him. `render_review` broke that identity: the hour now
 * starts a render and a *different* job, minutes later, makes the decision to
 * send it. Counting one job would have moved every sending outside the bound
 * without a line of code saying so — a limit silently repealed by a feature
 * that never mentioned it.
 *
 * `morning_agenda` is deliberately NOT here. The brief is a fixed slot in his
 * rhythm that he is already expecting, announced by a note at 07:00; spending
 * the day's spare-time allowance on it would mean a morning brief could use up
 * what she had for the afternoon.
 *
 * `maintenance` is the render review. It is filed under that kind rather than
 * under one of its own because widening `jobs.kind` would cost the run ledger —
 * the argument is in `jobs/render-review-job.ts`, beside `RENDER_REVIEW_KIND`.
 */
export const REACHING_KINDS: readonly string[] = ["heartbeat", "maintenance"];

/**
 * The scheduled turns the hour stands aside for.
 *
 * > *"I think she should be able to file things over night. I just suspect the
 * > hourly heartbeat at night won't have much value and might even conflict
 * > with the dreaming or morning routines."*
 * >                                        — the Commander, 2026-08-11
 *
 * **Yielding, not skipping.** He asked to keep the overnight hours — she may
 * still file at 02:00 — so nothing here refuses an hour for being at night. It
 * refuses an hour that would get in the way of a turn that matters more, at any
 * time of day, and the ordering is the one already written into
 * `JobPriority`: the hour is the only `background` job that takes a turn.
 *
 * **`morning_agenda` is the collision that is real.** The brief must exist
 * before the 07:00 note announces it, `agendaWallTime()` starts it
 * {@link COMPOSE_LEAD_MS} ahead for exactly that reason, and an hour still in
 * flight at 06:45 spends that lead on itself. `JobRunner` runs one job at a
 * time, so this was already true before the lanes merged; the merge sharpened
 * it, because both turns now resume one session and the queue in `SylAgent`
 * makes them exclusive on that too.
 *
 * **`nightly_consolidation` is the collision that is not.** Measured from the
 * code rather than guarded against by reflex: the dream is `scheduled` priority
 * and the hour is `background`, `JobStore.due` sorts on that, and `JobRunner`
 * never runs two handlers at once — so when both are due the dream goes first
 * and they cannot overlap. It also keeps its own lane (`LANES.consolidation`,
 * memoryless), so the lane merge did not bring it any nearer to the hour. What
 * remains is the same one-sided cost the agenda has: a dream that is due at
 * 03:00 waits for an hour that started at 02:59. That is worth avoiding for the
 * same reason and by the same rule, so it is listed — but it is a delay, not
 * a contention, and the entry above is the one carrying the weight.
 */
export const OUTRANKS_THE_HOUR: readonly JobKind[] = ["morning_agenda", "nightly_consolidation"];

/**
 * How near a higher-ranked turn has to be before the hour stands aside.
 *
 * Derived, not typed: {@link COMPOSE_LEAD_MS} is the morning brief's own
 * statement of how long composing may take, and it is longer than the longest
 * the hour can hold anything — one turn, `maxWallClockMs` of five minutes, and
 * `DEFAULT_TURN_TIMEOUT_MS` of ten behind that. So an hour that starts outside
 * this window has finished before the thing it was making way for is due, and
 * an hour inside it stands aside. Move the announcement and both numbers move
 * together, which is the property a literal here would lose.
 */
export const YIELD_WINDOW_MS = COMPOSE_LEAD_MS;

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
      // This turn carries an MCP surface; saying `[]` here would be
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
    `You can see his body too: \`how_has_he_been\` gives you his sleep, his heart, his ` +
      `movement and his weight as they have been lately against his own baseline. It is ` +
      `cheap and it is current. He asked for this to be something you raise rather than ` +
      `something he has to ask about — so if you find something there worth saying, say it. ` +
      `Read what it tells you about whether a number is missing before you call it missing: ` +
      `a type nothing has ever published is a fact about his ring, not about him.`,
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
 * to its signature is a type error here rather than a double that has drifted
 * from the thing it stands in for.
 *
 * **No `reset`.** It used to have one, because the hour ran on a thread of its
 * own that was deliberately a day long. That thread is now his (see
 * `harness/agent.ts`), and `reset` on it deletes the conversation the Commander
 * is having — so the handler is not given the method rather than being trusted
 * not to call it.
 *
 * **`busy` instead**, which is the same merge seen from the other side: the
 * hour now shares a thread with him and has to be able to notice he is using
 * it. See {@link OUTRANKS_THE_HOUR}.
 */
export type HeartbeatVoice = Pick<SylAgent, "ask" | "busy">;

export interface HeartbeatDeps {
  /** Syl on the commander lane: the thread he talks to, resumed. */
  readonly voice: HeartbeatVoice;
  /**
   * The ledger, and the catalogue.
   *
   * `listRuns` is what she has already spent today. `list` is what else is
   * about to want the thread — see {@link OUTRANKS_THE_HOUR}.
   */
  readonly jobs: Pick<JobStore, "listRuns" | "list">;
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
  /**
   * What his thread currently costs to replay, so the hour can sweep it.
   *
   * ## Why the hourly ping is where compaction lives
   *
   * `syl-chzl.4.4`: his lane reached **861,739 tokens** and had never been
   * compacted, which put the first token of every turn 9-16 seconds away and
   * made her face physically incapable of answering inside Runway's 8s ceiling.
   * The remedy the Commander chose in advance is summarisation *inside* that
   * thread, and `harness/compaction.ts` holds the mechanism and the argument.
   *
   * It is hosted here rather than given a job of its own for three reasons,
   * and the first is the one that decided it:
   *
   *  - **The hour is already the scheduled visitor to his lane.** It resumes
   *    that session, it already stands aside for anything that outranks it, and
   *    it already knows whether he is asleep. A compaction is lane housekeeping
   *    and this is the recurring turn that holds the lane.
   *  - **A job of its own would cost a `JobKind`**, which is generated from
   *    `shared/openapi.yaml` — and `docs/CONTEXT.md` records that a contract
   *    change is not separable from the Swift client. That is a large, risky
   *    edit in a shared worktree for a latency fix. `jobs/render-review-job.ts`
   *    made the same call for the same reason; see `RENDER_REVIEW_KIND`.
   *  - **It must never be a face's problem.** Compaction measured 104,504ms
   *    against the real binary. Hosting it in a scheduled job — rather than in
   *    `--autocompact`, which would fire it on whichever turn crossed the
   *    threshold — is what keeps those 104 seconds off `ask_syl` forever.
   *
   * Optional, and absence means never compact: {@link whyNotCompact} refuses on
   * an unknown size, so a caller that does not wire this loses the sweep rather
   * than getting an unmeasured one.
   */
  readonly contextSizes?: Pick<LaneContextSizes, "tokens" | "forget">;
  // No clock. Every instant this handler needs is `context.now` — the instant
  // the runner leased the job at, and the one the run record and the lateness
  // are measured from. A second clock here could disagree with it.
}

/** The local day a run started on, or `null` for an instant that will not parse. */
function dayOf(startedAt: string, tz: string): string | null {
  const at = parseInstant(startedAt);
  return at === null ? null : localDate(new Date(at), tz);
}

/**
 * How many times she has reached him since local midnight.
 *
 * Counted across {@link REACHING_KINDS} rather than over one job, so a sending
 * decided on the `studio` lane spends from the same day as an hour that
 * reached him. Exported because `jobs/render-review-job.ts` reads the same
 * number — two implementations of one ceiling is two ceilings, and the one
 * that drifts is the one nobody is looking at.
 *
 * `exceptRunId` is this pass's own run row, which `JobRunner` opens before
 * calling the handler. It is excluded by id rather than by guesswork about
 * ordering.
 */
export function reachedHimToday(
  jobs: Pick<JobStore, "listRuns">,
  options: {
    readonly exceptRunId: string;
    readonly now: number;
    readonly tz: string;
    readonly kinds?: readonly string[];
  },
): number {
  const runs = jobs
    .listRuns({ kinds: options.kinds ?? REACHING_KINDS, limit: LEDGER_DEPTH })
    .items.filter((run) => run.id !== options.exceptRunId);

  const today = localDate(new Date(options.now), options.tz);

  let spent = 0;
  for (const run of runs) {
    if (run.spoke && dayOf(run.startedAt, options.tz) === today) spent += 1;
  }
  return spent;
}

/**
 * What the hour should stand aside for right now, or `null` to go ahead.
 *
 * Returns the reason in words because it becomes the run record's summary, and
 * "yielded" without a subject is a line nobody can act on.
 *
 * Exported so the reasoning can be tested without a handler, a store or a
 * clock — it is the whole of the decision, and the handler around it is four
 * lines of plumbing.
 */
export function whatOutranksTheHour(
  deps: Pick<HeartbeatDeps, "voice" | "jobs">,
  now: number,
  kinds: readonly JobKind[] = OUTRANKS_THE_HOUR,
): string | null {
  // HIM FIRST. He outranks everything, and unlike the jobs below there is no
  // schedule to read: the only evidence that he is mid-conversation is that a
  // turn is on the lane. Without this the hour joins the queue behind him and
  // his next message waits for a turn nobody asked for.
  if (deps.voice.busy()) {
    return "the Commander was mid-turn on the same thread";
  }

  for (const kind of kinds) {
    for (const job of deps.jobs.list({ kind, limit: 4 }).items) {
      // Already holding it. `JobRunner` runs one job at a time so this should
      // not be reachable in a single-process service — it is checked anyway,
      // because "should not be reachable" is a claim about today's runner and
      // this is a claim about the hour.
      if (job.state === "leased" || job.state === "running") {
        return `${kind} was already running`;
      }

      // ABOUT to want it, and strictly about to. `nextRunAt` is the instant the
      // trigger computed, so this asks the schedule rather than re-deriving a
      // wall time here — the one place that could drift from what is actually
      // going to happen.
      //
      // A job that is due NOW or overdue is deliberately not a reason to stand
      // aside, and that is load-bearing rather than a rounding decision.
      // `JobStore.due` sorts `background` last and `JobRunner` runs one job per
      // pass, so the hour being picked at all already means nothing that
      // outranks it is due — the runner has made that decision and this would
      // only be re-making it. Worse, it would re-make it wrongly: a job stuck
      // due in the past (a circuit breaker open, a handler that keeps failing)
      // would silence the hour permanently, and an hour that never runs again
      // while every signal stays green is the failure shape this project keeps
      // finding. So this window covers exactly the case the runner cannot see:
      // the brief that becomes due while an hour started a minute ago is still
      // talking.
      const due = job.nextRunAt === null ? null : parseInstant(job.nextRunAt);
      if (due !== null && due > now && due - now <= YIELD_WINDOW_MS) {
        return `${kind} was due within ${describeMinutes(YIELD_WINDOW_MS)}`;
      }
    }
  }

  return null;
}

/** "fifteen minutes", roughly, for a duration in milliseconds. */
function describeMinutes(ms: number): string {
  return `${String(Math.round(ms / 60_000))} minutes`;
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

    // STAND ASIDE, BEFORE ANYTHING IS SPENT. The hour is the lowest-priority
    // thing on his thread and behaves like it: no turn, no cost, and a
    // `success` — a yielded hour is not a failed one and must not walk the
    // circuit breaker towards taking the hour away altogether.
    //
    // No `nextRunAt`, deliberately, exactly as the failure branch below: the
    // interval trigger computes the next hour, which is strictly later. `null`
    // would write `next_run_at = NULL` and take the job out of `due` forever —
    // the silent drop constraint 4 forbids, arriving through the polite path.
    const yielded = whatOutranksTheHour(deps, now);
    if (yielded !== null) {
      return {
        outcome: "success",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: `Stood aside: ${yielded}. The next hour is at most an hour away.`,
        error: null,
      };
    }

    const spentToday = reachedHimToday(deps.jobs, {
      exceptRunId: context.run.id,
      now,
      tz: deps.tz,
    });

    // NOTHING IS RESET HERE, and the absence is the decision. The hour used to
    // start a fresh thread each local day, because a lane of its own carrying
    // 24 turns a day forever is a transcript every later turn pays to re-read.
    // The thread is his now, and starting a fresh one would delete the
    // conversation the Commander is having — so the bound has to be found
    // somewhere other than the scissors. He has taken that trade explicitly:
    // *"if it causes bloat on that thread we can solve it later."*

    const inQuietHours = isWithinQuietHours(new Date(now), deps.quiet, deps.tz);

    // HOUSEKEEPING FIRST, AND ONLY WHILE HE IS ASLEEP.
    //
    // A thread over budget makes every later turn slow — including the face
    // turns that must finish inside 6,500ms — so sweeping it outranks anything
    // this hour would otherwise have thought about. It replaces the hour's own
    // turn rather than running beside it: both are turns on one session, they
    // would serialise anyway, and a 104-second compaction followed by a
    // heartbeat is two minutes of his lane for a pass that usually ends in
    // nothing.
    //
    // `whyNotCompact` holds every gate, so this branch cannot open by accident:
    // over budget, quiet hours, and an idle lane, with an unknown size refusing.
    const before = deps.contextSizes?.tokens(LANES.commander);
    const notNow = whyNotCompact({ tokens: before, inQuietHours, busy: deps.voice.busy() });
    if (notNow === null && before !== undefined) {
      const outcome = await compactLane({ ask: (text) => deps.voice.ask(text), before });
      // FORGET THE OLD SIZE, whether it worked or not. The compaction turn
      // reports no usage, so nothing here can learn the new size — and the
      // stale one is still over budget, which would make the next hour compact
      // again, and the one after that, all night, each reporting a saving
      // computed from a number that no longer describes anything.
      // `whyNotCompact` refuses on an unknown size, so the lane waits for the
      // next real turn to say. On a FAILED compaction this is equally right:
      // whatever went wrong, what we believed about the thread is now a guess.
      deps.contextSizes?.forget(LANES.commander);
      deps.log?.log(outcome.ok ? "info" : "error", "heartbeat.compacted", {
        at: instant(now),
        before: outcome.before,
        after: outcome.after ?? null,
        error: outcome.error,
      });
      return {
        // A failed compaction is a failed hour: it is loud, it is nowhere near
        // him, and the circuit breaker should see a sweep that never works.
        outcome: outcome.ok ? "success" : "failure",
        spoke: false,
        turns: 1,
        costUsd: 0,
        summary: describeCompaction(outcome),
        error: outcome.error,
        // No `nextRunAt`, as everywhere else here: the interval trigger computes
        // the next hour. `null` would take the job out of `due` forever.
      };
    }

    const prompt = heartbeatPrompt({
      now,
      tz: deps.tz,
      quiet: deps.quiet,
      inQuietHours,
      spentToday: spentToday,
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
    const overspent = spoke && spentToday >= allowance;

    if (spoke) {
      deps.log?.log("info", "heartbeat.reached", {
        at: instant(now),
        spentToday: spentToday + 1,
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
        ? `She reached him on an hour with nothing left to spend: ${String(spentToday)} ` +
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
