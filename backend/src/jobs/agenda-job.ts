import type { Job, JobTrigger } from "@syl/shared";

import type { SylAgent } from "../harness/agent.js";
import type { SylEvent } from "../harness/protocol.js";
import { isWithinQuietHours, wallClockIn, type QuietHours } from "../harness/schedule.js";
import type { TurnResult } from "../harness/session.js";
import type { Logger } from "../ops/logging.js";
import { instant } from "../services/clock.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import { nextRunAtFor, type JobStore } from "../services/job-store.js";
import { mcpToolName } from "../tools/config.js";
import { advertisedToolNames } from "../tools/server.js";
import { RHYTHM_GRACE_MS } from "./deliver-reminders.js";

/**
 * The morning agenda: the turn that composes the brief his 07:00 note announces.
 *
 * ## The defect this exists for
 *
 * A lane for it had been declared since the harness was written, the job
 * catalogue has carried `morning_agenda` since `0007_jobs.sql`, and at least
 * three files' comments described the morning brief as a working part of her
 * rhythm. **Nothing defined the job and nothing scheduled it.** The only thing
 * that happened at 07:00 was a note telling him his objectives were ready, and
 * no process had ever assembled them — prose asserting a capability the code did
 * not have, sitting in the middle of her own day.
 *
 * ## Everything here turns on one ordering
 *
 * The brief exists **before** the note that announces it. That is the whole
 * specification, and three separate things are in service of it:
 *
 *  - {@link agendaWallTime} is derived by subtracting {@link COMPOSE_LEAD_MS}
 *    from {@link ANNOUNCEMENT_WALL_TIME}, rather than being a number chosen to
 *    look early. Move the announcement and the composition moves with it.
 *  - `budget.maxWallClockMs` is capped at the lead, so a turn that runs to its
 *    own limit still finishes before the note fires. An ordering that only holds
 *    for a fast morning is not an ordering.
 *  - The trigger is `wall_clock` in an IANA zone (constraint 5). A fixed offset
 *    drifts an hour at each DST boundary, which would put the brief on the wrong
 *    side of the announcement twice a year — silently, and looking like data.
 *
 * ## Why it is not an interval, the way the heartbeat is
 *
 * `heartbeat-job.ts` argues at length that an interval keeps the hour off a
 * timetable, because a thing that reliably arrives at the same minute is a
 * newsletter. That argument is exactly right for spare time and exactly wrong
 * here: **this IS the timetable.** A morning brief that wandered would not be a
 * morning brief, and the note at 07:00 is already telling him when to expect it.
 *
 * ## What it does with the hour
 *
 * It wakes her on `LANES.commander` — his own thread, on his ruling of
 * 2026-08-11; see `harness/agent.ts` — with her hands attached, and points her at
 * `whats_outstanding` — the verb she already has, which returns his open
 * reminders, to-dos and goals. It does not stuff his data into the prompt. A
 * turn that looks sees what is true when it looks; a turn that is told sees what
 * was true when the prompt was built, and has no way to tell the difference.
 *
 * ## The brief PREPARES the day; it does not describe it
 *
 * The Commander's specification, and it is five things: *"the morning review
 * should prepare the day. It should look at all the todos reminders and the
 * goals. It should then try and consolidate and plan out the best order of
 * operations and the best approach to accomplish it all and prioritize and
 * figure out what's at risk of not getting done."*
 *
 * It already triaged, and triaged well — *"Ten things are dated for today and
 * only three of them are real"*. **Nothing did the fifth.** A brief that lists
 * his day back in a better order is worth something; one that says *these two
 * will not both happen and here is which to drop* is worth much more, and it is
 * the only part of this his day does not already contain somewhere.
 *
 * The goals are load-bearing for the middle three rather than being a third
 * list to recite: they are the only thing that makes one item outrank another
 * for a reason he can argue with. Prioritising without them is a preference
 * wearing a plan's clothes.
 *
 * ## The half of that which is a guard
 *
 * Consolidating and prioritising both mean touching his list, and constraint 6
 * governs: **the system does not silently discard.** So the plan lives in the
 * BRIEF. She says what she would merge and he merges it — a merge destroys one
 * of two items, and there is no version of that she may do on her own.
 *
 * Scheduling is the one safe write and she keeps it, at a price: **every change
 * she makes is named in the brief that made it.** He must never open his list
 * and find it rearranged by something he did not watch, because a move he was
 * not told about is indistinguishable from his own memory failing.
 *
 * The prompt is an instruction and instructions are not guarantees — nothing in
 * the harness can stop a turn using a verb it has, and `budget.allowedTools` is
 * a catalogue record that enforces nothing. So the guarantee actually available
 * is that it cannot happen QUIETLY: {@link prunedHisList} reads the turn's own
 * events and {@link createMorningAgendaHandler} says so in the log, on the
 * morning it happened, naming the verb.
 *
 * ## A morning with no brief in it is loud, and still a success
 *
 * Recording an empty morning as a *failure* would walk the job's circuit breaker
 * towards open, and five quiet mornings would take the rhythm away entirely —
 * which is this defect returning through a different door. So it is a success
 * with `spoke: false`, and a line in the log that says so.
 */

/**
 * The wall time of the note he already has, which announces the brief.
 *
 * Named here because {@link agendaWallTime} is derived from it, and because a
 * turn has to be able to say "there is a note at 07:00 telling him this is
 * ready" — she cannot be early on purpose without knowing what she is early for.
 */
export const ANNOUNCEMENT_WALL_TIME = "07:00";

/** How long before the announcement the brief is composed. */
export const COMPOSE_LEAD_MS = 15 * 60_000;

/**
 * The wall time the brief is composed at, given the note that announces it.
 *
 * Derived rather than written down, so the ordering is a property of the code
 * rather than of two numbers that agree today.
 */
export function agendaWallTime(
  announcement: string = ANNOUNCEMENT_WALL_TIME,
  leadMs: number = COMPOSE_LEAD_MS,
): string {
  const [hour, minute] = announcement.split(":").map(Number);
  const minutes = (hour ?? 0) * 60 + (minute ?? 0) - Math.round(leadMs / 60_000);
  // Wrapped rather than clamped: an announcement early enough that the lead
  // crosses midnight belongs on the previous day, not at 00:00.
  const wrapped = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** The slot itself, resolved once. */
export const MORNING_AGENDA_WALL_TIME = agendaWallTime();

/**
 * The verbs that mean the brief now exists somewhere he will find it.
 *
 * `remind_me` puts her words in front of him at a time, composed in her voice
 * and read back verbatim; `show_him` is the sending, which lands in his
 * conversation and on his lock screen; `tell_him` is the same landing with no
 * render on it (`syl-0x1h`), which is the likeliest shape for a brief that is a
 * paragraph rather than a list. Reading (`whats_outstanding`) is not composing,
 * and a morning that only read is a morning with no brief in it — which is
 * precisely the state this job was written to end.
 */
export const PUTS_IT_IN_FRONT_OF_HIM: readonly string[] = [
  "remind_me",
  "show_him",
  "tell_him",
];

/**
 * The verbs whose effect is that something he had is no longer there.
 *
 * Not "dangerous verbs" and not a permission list — she has all of these all
 * day, and on his own instruction she uses them when he tells her to. This is
 * the set that has no business in a **planning** turn: the morning brief reads
 * his day and proposes, and every one of these concludes something instead. If
 * an inference behind one is wrong the item is gone and he never learns it
 * existed, which is the silent discard constraint 4 exists to forbid.
 *
 * `change_goal` is deliberately absent even though it can retire a goal: the
 * same verb also merely rewords one, so watching it would report a correction
 * as a loss. The prompt covers the goal case in words; this covers the three
 * that can only take something away.
 */
export const TAKES_SOMETHING_OFF_HIS_LIST: readonly string[] = [
  "finish_todo",
  "drop_todo",
  "cancel_reminder",
];

/** The longest of her own sentences the run record keeps. */
const SUMMARY_LIMIT = 500;

/** Where the morning happens, and the window it is composed inside. */
export interface AgendaSchedule {
  /** IANA, never a fixed UTC offset. Constraint 5. */
  readonly tz: string;
  /** His sleep. The brief is composed inside it; it arrives when it ends. */
  readonly quiet: QuietHours;
}

/** The trigger this job carries. A place and a wall time, never an offset. */
export function agendaTrigger(schedule: AgendaSchedule): JobTrigger {
  return { type: "wall_clock", wallTime: MORNING_AGENDA_WALL_TIME, tz: schedule.tz };
}

/** The catalogue entry for the morning brief. */
export function defineMorningAgendaJob(
  store: JobStore,
  schedule: AgendaSchedule,
  firstRunAt?: string,
): Job {
  return store.define({
    kind: "morning_agenda",
    // `scheduled`, not `background`. The hourly self-ping is spare time and can
    // wait behind anything; this is a fixed slot in his rhythm that a note is
    // already announcing. It still sorts below `interactive` and `reminder`, so
    // it can never displace him or a commitment he is relying on.
    priority: "scheduled",
    trigger: agendaTrigger(schedule),
    // Nothing to resume and nothing worth writing twice: a second pass over the
    // same morning composes a second brief.
    deliveryClass: "at_most_once",
    // The same number `deliver-reminders.ts` already uses for the rhythm
    // messages it delivers, imported rather than chosen again: a brief that
    // arrives at 10:00 is still a morning brief, and one that arrives at 16:00
    // is an interruption about a morning that already happened.
    catchUp: { policy: "grace_window", graceMs: RHYTHM_GRACE_MS },
    budget: {
      // One wake, one turn. She may reach for several verbs inside it.
      maxTurns: 1,
      // Capped at the lead, which is what makes the ordering hold for a SLOW
      // morning as well as a fast one. A turn allowed to run past the
      // announcement is a turn that can be composing while he is being told it
      // is ready.
      maxWallClockMs: COMPOSE_LEAD_MS,
      // Derived from the server rather than written out beside it, so the
      // catalogue cannot claim a verb she does not have — or miss one she does.
      // This turn carries an MCP surface; saying `[]` here would be the
      // same false security claim `syl-009.9` was about.
      allowedTools: advertisedToolNames().map(mcpToolName),
    },
    // It is the one scheduled turn whose whole purpose is to put something in
    // front of him. `Run.spoke` records whether it managed to.
    speaks: true,
    ...(firstRunAt === undefined ? {} : { nextRunAt: firstRunAt }),
  });
}

/**
 * Find the one `morning_agenda` job, or create it.
 *
 * Exactly one exists, forever. `nextRunAt` is state — the instant the last pass
 * decided it next needed to wake — and redefining the row on every boot would
 * throw that away along with its circuit breaker.
 *
 * The first run is computed from `now`, the runner's clock, rather than left to
 * the store's: those are the same instant in production and deliberately
 * different in a test, and a job scheduled off a clock nobody injected is a job
 * no test can place in the morning.
 */
export function ensureMorningAgendaJob(
  jobs: JobStore,
  schedule: AgendaSchedule,
  now: number,
): Job {
  const existing = jobs.list({ kind: "morning_agenda", limit: 1 }).items[0];
  if (existing !== undefined) return existing;
  const first = nextRunAtFor(agendaTrigger(schedule), now);
  return defineMorningAgendaJob(jobs, schedule, first ?? undefined);
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

/** Everything the morning needs to know about itself. */
export interface AgendaMoment {
  readonly now: number;
  readonly tz: string;
  readonly quiet: QuietHours;
  /** The wall time of the note that tells him the brief is ready. */
  readonly announcedAt: string;
  /** Whether he is asleep. Decided by `harness/schedule.ts`, never re-derived. */
  readonly inQuietHours: boolean;
  /** Whether this slot was missed and is being caught up inside its grace window. */
  readonly late: boolean;
}

/**
 * What she is woken with.
 *
 * Three jobs, then the Commander's five, then two that pull against each other:
 *
 * 1. **Say what the turn is for.** A brief, composed now, announced at
 *    {@link AgendaMoment.announcedAt} by a note she did not write.
 * 2. **Send her to look rather than hand her a copy.** `whats_outstanding` is
 *    named because it is the verb she has, and because what it returns is true
 *    at the moment she calls it. `of: everything` is named too — a default is
 *    not an instruction, and a turn told to "look at his day" reaches for the
 *    to-dos and leaves the goals unread.
 * 3. **Make it clear the brief has to be FILED.** The turn's own text goes to a
 *    run record. If she only answers, the note at 07:00 announces nothing, which
 *    is the exact defect this job was built to end.
 *
 * Then read, consolidate, order, prioritise, and name what is at risk — the
 * header explains why the fifth is the one worth having and why the second and
 * fourth need a guard around them.
 *
 * 4. **Let a quiet morning be short.** A daily slot is where an assistant learns
 *    to manufacture content, and `SOUL.md` is unambiguous about what that costs:
 *    *an assistant that speaks constantly gets muted.* Three real lines beat a
 *    page, and no real lines beats three invented ones.
 * 5. **Let a safe morning be a safe morning.** The same failure at its sharpest:
 *    a turn asked every day what is at risk will find something. An invented
 *    risk is worse than a missing one, because it is the sentence that teaches
 *    him to skip the real one, so "nothing is at risk" has to be a permitted and
 *    ordinary answer.
 */
export function agendaPrompt(moment: AgendaMoment): string {
  return [
    `It is ${wallClockIn(new Date(moment.now), moment.tz)} in ${moment.tz}. This is the ` +
      `morning brief — his day, assembled by you, before he is awake enough to ask for it. It ` +
      `prepares the day rather than describing it.`,
    `He has a note at ${moment.announcedAt} telling him his objectives are ready. You did not ` +
      `write it and it does not know what you found; it only says the brief exists. So the ` +
      `brief has to exist by then, which is why you are up before it.`,
    `Look at all of it first: \`whats_outstanding\` with \`of: everything\` gives you his ` +
      `reminders, his to-dos and his goals as they actually are. Nothing here has told you ` +
      `what is on them, on purpose. What you read is true when you read it; what you were ` +
      `handed is true whenever somebody built the sentence. Read the goals as carefully as the ` +
      `list — the goals are what make an order defensible instead of arbitrary.`,
    `Consolidate: say where two of his items are the same thing said twice, and where three of ` +
      `them are really one afternoon's work. Name them and propose the merge in words. Do not ` +
      `perform it — merging two of his to-dos destroys one, and that is his call, not yours.`,
    `Order it: anything with an hour on it is a fixed point, and the day is built around those ` +
      `rather than fitted in beside them. Put the rest in a sequence and say why each one is ` +
      `where it is — it unblocks the next, it needs him before he is tired, it has to be done ` +
      `before the call. A list in a better order is not a plan; the reasons are the plan.`,
    `Prioritise by what a thing serves. A to-do that moves one of his goals outranks one that ` +
      `does not — say which goal, so he can argue with the ranking and not just the list. ` +
      `Between two that both serve a goal, the one with a real deadline wins.`,
    `Then say what is at risk of not getting done, which is the part nothing else in his day ` +
      `does for him. Not "it will be tight": name the item, say why it will not fit — the ` +
      `hours it needs against the hours he has, or the thing ahead of it that will overrun — ` +
      `and say what to do about it: drop it, move it to a day you name, or cut it down to the ` +
      `part that has to happen today. A warning he cannot act on is not a warning. If nothing ` +
      `is at risk, say so in a sentence and move on; a risk invented because the morning came ` +
      `round is what teaches him to ignore the real one.`,
    handsClause(),
    `Then put it in front of him with your hands, so it is waiting when the note arrives. Lead ` +
      `with what he has to do today. This is one brief that has done five things, not five ` +
      `headings — a quiet day is three sentences and a hard day is still short enough to hold ` +
      `in his head. Yesterday's brief is gone; this one stands on its own.`,
    quietClause(moment),
    ...(moment.late ? [lateClause(moment)] : []),
    `What you say here is not sent to him. It is written down, and read by nobody unless ` +
      `something went wrong. Putting the brief in front of him is a separate thing you do ` +
      `deliberately, with your hands.`,
  ].join("\n\n");
}

/**
 * What she may change on his list this morning, and what she may not.
 *
 * The prohibitions are in ENGLISH rather than in verb names, deliberately. The
 * rule `tools/schemas.ts` states — prose that says "you may not X" goes stale
 * the day X is allowed, and a stale instruction fails silently by being acted
 * out — bites hardest when the prose names identifiers, because those are what
 * a rename moves. "Nothing comes off his list this morning" stays true through
 * any renaming, and {@link prunedHisList} is the half that watches rather than
 * asks.
 */
function handsClause(): string {
  return (
    `Your hands may plan and they may not prune. Set a reminder for anything with an hour on ` +
    `it, and put a date on a to-do — or pin the one thing that leads the day — when the plan ` +
    `you just made says so. Then say, in the brief, every change you made and why: he must ` +
    `never open his list and find it rearranged by something he did not watch. Nothing comes ` +
    `off that list this morning. Do not finish anything, do not drop anything, do not cancel ` +
    `his reminders, do not retire a goal, and do not fold two of his items into one. You say ` +
    `what should go; taking it is his.`
  );
}

/**
 * The ceiling on the morning prompt, in bytes.
 *
 * A tripwire on a prompt that has run away, not a token economy — the same
 * shape as `SYSTEM_PROMPT_MAX` in `harness/turn-context.ts`, and here for the
 * same reason: this is the file where prose grows, every sentence in it is paid
 * on every morning forever, and the margin was the thing nobody measured when
 * the system prompt quietly ate its own twice in a day.
 *
 * Measured on 2026-08-12: **3,640 bytes**, and 3,855 on a morning that is late.
 * The five things the Commander asked for cost about 2,100 of that; the brief
 * used to say only "look, then compose" and ran to roughly 1,600. 6,000 leaves
 * room for another clause and not for a second brief, which is the size a
 * tripwire wants — big enough that a paragraph cannot trip it, small enough
 * that it goes off long before anyone would notice from the bill.
 *
 * If a sixth thing the brief must do genuinely does not fit, raise this and
 * record the new measurement in the same breath; if one clause has bloated,
 * narrow the clause. Do not raise it without re-measuring — a number in prose
 * beside a number in code is how the system prompt lost its margin twice.
 */
export const AGENDA_PROMPT_MAX_BYTES = 6_000;

/** What this morning's prompt actually costs, counted the way the cap counts it. */
export function agendaPromptBytes(moment: AgendaMoment): number {
  return Buffer.byteLength(agendaPrompt(moment), "utf8");
}

/** The sentence about whether he is awake to receive it. */
function quietClause(moment: AgendaMoment): string {
  if (!moment.inQuietHours) {
    return (
      `He is up, so anything you put in front of him now can arrive now. Quiet hours are ` +
      `${moment.quiet.start} to ${moment.quiet.end}.`
    );
  }

  return (
    `He is still asleep. Quiet hours run to ${moment.quiet.end}, and nothing you file reaches ` +
    `him before then however you file it — that is deliberate, and protecting his sleep is ` +
    `worth more than being early. Compose it anyway; being ready before he wakes is the ` +
    `whole point of composing it now.`
  );
}

/** The sentence about a morning that is already half gone. */
function lateClause(moment: AgendaMoment): string {
  return (
    `This is late — the slot was missed and you are catching it up, so the note at ` +
    `${moment.announcedAt} has already gone out ahead of you. Say so rather than opening as ` +
    `though it were dawn, and drop anything the hour has overtaken.`
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
 * **`ask` and nothing else.** It used to include `reset`, and the brief called
 * it every morning, because a lane of its own left to resume would carry every
 * previous morning's assembly into the next one. On the Commander's lane —
 * *"the morning routine update should also be on the same lane for now"*,
 * 2026-08-11 — that call deletes his conversation, so the method is withheld
 * rather than the call merely being removed.
 */
export type AgendaVoice = Pick<SylAgent, "ask">;

export interface MorningAgendaDeps {
  /** Syl on the commander lane: the thread he talks to, resumed. */
  readonly voice: AgendaVoice;
  /** IANA, never a fixed offset. */
  readonly tz: string;
  readonly quiet: QuietHours;
  /** The wall time of the note that announces the brief. */
  readonly announcedAt?: string;
  /**
   * Where a morning that produced nothing, or died, is reported.
   *
   * Optional because a handler must work without one, and present because the
   * two things worth knowing about this job — it composed nothing, it failed —
   * are otherwise only visible in a runs table nobody tails.
   */
  readonly log?: Pick<Logger, "log">;
  // No clock. Every instant this handler needs is `context.now` — the instant
  // the runner leased the job at, and the one the run record and the lateness
  // are measured from. A second clock here could disagree with it.
}

/** Whether the turn put the brief somewhere he will find it. */
export function composedTheBrief(events: readonly SylEvent[]): boolean {
  // Both spellings. Claude Code presents an MCP verb as `mcp__syl__remind_me`,
  // which is what a real transcript carries; the bare name is accepted so that
  // a fixture written either way means the same thing.
  const filing = new Set<string>(
    PUTS_IT_IN_FRONT_OF_HIM.flatMap((verb) => [verb, mcpToolName(verb)]),
  );
  return events.some((event) => event.kind === "tool_use" && filing.has(event.name));
}

/**
 * Which of {@link TAKES_SOMETHING_OFF_HIS_LIST} this morning used, if any.
 *
 * Returns the bare verb names, in the order they were called and without
 * repeats, so the log line reads as a sentence about what happened rather than
 * as a tally. Empty on the morning it should be empty on — which is every one.
 */
export function prunedHisList(events: readonly SylEvent[]): readonly string[] {
  // Both spellings, for the same reason `composedTheBrief` accepts both: a real
  // transcript carries `mcp__syl__drop_todo` and a fixture may carry the bare
  // name, and a guard that only knows one of them reports every morning clean.
  const bare = new Map<string, string>();
  for (const verb of TAKES_SOMETHING_OFF_HIS_LIST) {
    bare.set(verb, verb);
    bare.set(mcpToolName(verb), verb);
  }

  const used: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool_use") continue;
    const verb = bare.get(event.name);
    if (verb !== undefined && !used.includes(verb)) used.push(verb);
  }
  return used;
}

/** A string cut to length, saying how much was dropped rather than trailing off. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${String(text.length - max)} more characters)`;
}

/** The run record's one line: her own sentence about the morning. */
function summarise(result: TurnResult): string | null {
  const text = result.text.trim();
  return text === "" ? null : cut(text, SUMMARY_LIMIT);
}

/** The handler: wake her, let her assemble his day, and write down what she did. */
export function createMorningAgendaHandler(deps: MorningAgendaDeps): JobHandler {
  const announcedAt = deps.announcedAt ?? ANNOUNCEMENT_WALL_TIME;

  return async (context): Promise<JobResult> => {
    const now = context.now;

    // NOTHING IS RESET HERE. The brief used to start a fresh thread each
    // morning, so that a day's assembly never carried every previous morning's
    // into it. It runs in his conversation now, where that call would delete
    // what he has been saying — and what has to survive between mornings was
    // never in the transcript anyway: it is in the stores she reads and in her
    // memory. The bloat is real and the Commander has taken it knowingly.

    const prompt = agendaPrompt({
      now,
      tz: deps.tz,
      quiet: deps.quiet,
      announcedAt,
      inQuietHours: isWithinQuietHours(new Date(now), deps.quiet, deps.tz),
      late: context.late,
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
      deps.log?.log("error", "agenda.failed", { at: instant(now), error: message });
      return {
        outcome: "failure",
        spoke: false,
        turns: 0,
        costUsd: 0,
        summary: null,
        error: message,
        // No `nextRunAt`. Omitting it lets the wall-clock trigger compute
        // tomorrow's slot; `null` would set `next_run_at = NULL` and take the
        // job out of `due` forever, which is the exact shape of a rhythm that
        // silently stops.
      };
    }

    const spoke = composedTheBrief(result.events);

    const pruned = prunedHisList(result.events);
    if (pruned.length > 0) {
      // Loud, and that is all. Not a failure — the brief was still composed and
      // recording this as one would walk the circuit breaker towards open and
      // take the whole rhythm away over a question of manners. Not a rollback
      // either: undoing a write on her behalf would be a second unwatched
      // change to his list, which is the thing being guarded against. What is
      // owed here is that it be visible on the morning it happened, with the
      // verb named, so nobody has to reconstruct it from a summary later.
      deps.log?.log("warn", "agenda.pruned", {
        at: instant(now),
        verbs: pruned,
        said: summarise(result),
      });
    }

    if (!spoke) {
      // Not a failure. Five consecutive failures open the circuit breaker and
      // take the morning away, and a run of quiet mornings is exactly how this
      // defect would come back. It is said out loud instead, where somebody
      // looking at why the brief stopped arriving can find it.
      deps.log?.log("warn", "agenda.composed_nothing", {
        at: instant(now),
        said: summarise(result),
      });
    }

    return {
      outcome: "success",
      spoke,
      turns: result.numTurns,
      costUsd: result.costUsd,
      summary: summarise(result),
      error: null,
    };
  };
}

/** The line to print about the morning agenda once it is scheduled. */
export function describeAgenda(job: Job, schedule: AgendaSchedule): readonly string[] {
  return [
    `[syl] the morning brief is composed at ${MORNING_AGENDA_WALL_TIME} ${schedule.tz}, ` +
      `ahead of the ${ANNOUNCEMENT_WALL_TIME} note that announces it; ` +
      `next ${job.nextRunAt ?? "unscheduled"}`,
  ];
}
