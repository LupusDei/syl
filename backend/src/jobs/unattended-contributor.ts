import type { JobKind, Run } from "@syl/shared";

import type { Contributor } from "../harness/turn-context.js";
import { parseInstant } from "../services/clock.js";

/**
 * What she did while nobody was watching, as one contribution to his turn.
 *
 * ## The defect
 *
 * The Commander found a reminder at 07:04 he had not asked for. Asked about it,
 * Syl said plainly that she had no memory of writing it — and she was right.
 * The hourly self-ping runs on `LANES.heartbeat`, with its own session, and the
 * morning brief on `LANES.agenda` with another. Lanes exist so her inner
 * monologue does not interleave with his conversation (`harness/agent.ts`), and
 * the cost of that separation had never been paid: **the Syl he talks to had no
 * way to know what the unattended Syl had done.**
 *
 * `CLAUDE.md` constraint 4 is about a reminder never vanishing. Its spirit is
 * that nothing she does is invisible, and here it was invisible to *her*, which
 * is the worst direction — an assistant that cannot account for its own actions
 * cannot be corrected, and cannot be trusted with more of them.
 *
 * ## Why this shape and not the others
 *
 * **Not a merged session.** Putting the commander lane and the hourly lane on
 * one session id would put his conversation in the same context as twenty-four
 * unattended turns a day, which is the exact failure `harness/agent.ts` created
 * lanes to prevent, and every later turn of his would pay to re-read them.
 *
 * **Not a verb.** `AGENT_SURFACE` deliberately excludes the record of what she
 * has done — `beyondAgentReach` says so in as many words, and `/logs` is
 * admin-scope for the same reason. Reading her runs over HTTP would mean
 * widening a security boundary that was argued shut, to answer a question that
 * can be answered without leaving the process.
 *
 * **Not provenance on the reminder row.** Marking each row with who created it
 * is the more complete answer and it is a migration, a contract change and a
 * client change — and it would still only cover reminders, not the hours she
 * spent deciding not to write one.
 *
 * So: the runs table, which already holds her own sentence about every
 * unattended turn, read in process, bounded, and composed into the one lane
 * where the question gets asked.
 *
 * ## Only the turns that reached him
 *
 * Twenty-three lines of "nothing worth saying" is not accountability; it is the
 * transcript the lanes exist to keep out. What he can ask about is what
 * arrived, so what she is shown is what arrived — `Run.spoke`, which
 * `heartbeat-job.ts` and `agenda-job.ts` both set from the verbs she actually
 * reached for.
 */

/** The kinds that run with nobody watching and may put something in front of him. */
export const UNATTENDED_KINDS: readonly JobKind[] = ["heartbeat", "morning_agenda"];

/**
 * How far back the record reaches.
 *
 * Two days. He is asking about a reminder he found this morning or a brief he
 * read yesterday, and a horizon is what keeps this small in the ORDINARY case
 * rather than leaving {@link UNATTENDED_MAX_BYTES} to do it by truncation. Past
 * it, the runs table is still the record; it is just no longer in front of her.
 */
export const UNATTENDED_HORIZON_MS = 48 * 60 * 60_000;

/**
 * The most this contributor will ever emit.
 *
 * Sized for the realistic worst case rather than for comfort: the heartbeat may
 * reach him four times a local day and the brief once, so two days is at most
 * ten entries, and ten entries at {@link SUMMARY_LIMIT} plus the preamble is
 * about this. Beyond it the oldest are dropped and the omission is stated.
 *
 * It is also a real claim on `DEFAULT_CONTEXT_BUDGET_BYTES`, which is why that
 * number moved when this landed. `tests/unit/tool-surface-budget.test.ts` adds
 * it up over the real constants, so the next contributor fails there rather
 * than in one of his replies.
 */
export const UNATTENDED_MAX_BYTES = 1_200;

/** The id this track answers to in every budget report. */
export const UNATTENDED_CONTRIBUTOR_ID = "unattended-work";

/**
 * How many runs the caller should read to cover {@link UNATTENDED_HORIZON_MS}.
 *
 * Only meaningful alongside `RunFilter.kinds`: runs are ordered by time across
 * every kind, and `reminder_delivery` wakes at least once a minute, so an
 * unfiltered page of this size would be entirely deliveries. Filtered to these
 * two kinds it is 24 hourly turns and one brief a day, which covers two days
 * with room over.
 */
export const UNATTENDED_RUN_DEPTH = 64;

/** How much of her own sentence survives into one line. */
const SUMMARY_LIMIT = 110;

/** What a turn of each kind is called, in the words she would use. */
const LABELS: Readonly<Record<string, string>> = {
  heartbeat: "on the hour",
  morning_agenda: "in the morning brief",
};

export interface UnattendedOptions {
  readonly now: number;
  /** IANA, never a fixed offset. Constraint 5 — the hours are read in his zone. */
  readonly tz: string;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The preamble, which does two things the entries cannot do for themselves.
 *
 * It says whose record this is — hers, of her own doing — so that it cannot be
 * read as something she knows about the Commander even though it is emitted
 * below `MEMORY_FENCE_END`. And it says the record is *partial by design*: only
 * the turns that reached him, so she does not conclude from a short list that
 * her quiet hours never happened.
 */
const PREAMBLE =
  "What you did while nobody was watching. These are your own unattended turns — the hour " +
  "that is yours and the morning brief — and only the ones where you actually put something " +
  "in front of him. It is a record of what you DID, not something you know about him: if he " +
  "asks about a reminder he does not remember asking for, this is how you know whether it " +
  "was you, and when.";

/** `Tue 07:04`, in his zone. Short, because ten of them share a ceiling. */
function shortWallClock(at: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}

/** A string cut to length, saying nothing about it — the entry is already terse. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** One line: when, which kind of turn, and what she said about it. */
function line(run: Run, tz: string): string {
  const at = parseInstant(run.startedAt);
  const when = at === null ? "at an unrecorded hour" : shortWallClock(at, tz);
  const what = LABELS[run.kind] ?? "unprompted";
  const said =
    run.summary === null || run.summary.trim() === ""
      ? "no note kept of what it was"
      : cut(run.summary.trim(), SUMMARY_LIMIT);
  return `- ${when}, ${what}: ${said}`;
}

/** What she is told about the older entries there was no room for. */
function omissionNote(count: number): string {
  return (
    `[${String(count)} earlier ${count === 1 ? "one is" : "ones are"} not shown here — there was ` +
    `not room. Nothing has been lost; say so if it matters.]`
  );
}

/**
 * Compose the record of her own unattended work, or nothing at all.
 *
 * @param runs any recent runs, in any order — `JobStore.listRuns` returns them
 * newest first, and this does not depend on that.
 * @returns `undefined` when she has done nothing unprompted inside the horizon.
 * Not a blank contributor: a section that is present and empty reads as a record
 * that failed to load, and `composeTurnContext` would drop it anyway.
 */
export function unattendedContributor(
  runs: readonly Run[],
  options: UnattendedOptions,
): Contributor | undefined {
  const kinds = new Set<string>(UNATTENDED_KINDS);
  const floor = options.now - UNATTENDED_HORIZON_MS;

  const relevant = runs
    .filter((run) => run.spoke && kinds.has(run.kind))
    .map((run) => ({ run, at: parseInstant(run.startedAt) }))
    // An unparseable instant is dropped rather than shown undated: a line she
    // cannot place in time cannot answer the question this exists to answer.
    .filter((entry): entry is { run: Run; at: number } => entry.at !== null)
    .filter((entry) => entry.at >= floor)
    // Newest first, whatever order the caller had them in.
    .sort((a, b) => b.at - a.at);

  if (relevant.length === 0) return undefined;

  const kept = fit(relevant.map((entry) => line(entry.run, options.tz)));
  const dropped = relevant.length - kept.length;
  const note = dropped === 0 ? "" : `\n${omissionNote(dropped)}`;

  return {
    id: UNATTENDED_CONTRIBUTOR_ID,
    kind: "ledger",
    text: `${PREAMBLE}\n\n${kept.join("\n")}${note}`,
  };
}

/**
 * The newest prefix of `lines` that fits, keeping at least one.
 *
 * Grown from the newest end and re-measured at each step, because the omission
 * note's own length depends on how many were dropped. Always keeps one: if even
 * the newest line will not fit, the right failure is `composeTurnContext`
 * throwing about a contributor that exceeded its own declaration — which is what
 * that check is for — rather than an omission note standing where the answer
 * should be.
 */
function fit(lines: readonly string[]): readonly string[] {
  const overhead = byteLength(PREAMBLE) + byteLength("\n\n");
  let kept: readonly string[] = lines.slice(0, 1);

  for (let end = 2; end <= lines.length; end += 1) {
    const candidate = lines.slice(0, end);
    const dropped = lines.length - end;
    const note = dropped === 0 ? "" : `\n${omissionNote(dropped)}`;
    const bytes = overhead + byteLength(candidate.join("\n")) + byteLength(note);

    if (bytes > UNATTENDED_MAX_BYTES) break;
    kept = candidate;
  }

  return kept;
}
