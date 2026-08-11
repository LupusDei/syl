/**
 * Where a reminder came from, as pure functions.
 *
 * `syl-y82`. The store could not tell an anticipated reminder from a requested
 * one, so neither could a careful reader with the database open — and one got
 * it wrong out loud. `SOUL.md` promises the Commander two things about
 * anticipation: that every unprompted thing she offers carries its reason, and
 * that he can therefore "tell you to stop making a kind he does not want".
 * The second promise needs a *list he can scan*, which is what this feature is.
 *
 * Two fields answering two different questions, and keeping them apart is the
 * point. `because` is prose — it answers "why does this exist" and only
 * sometimes "did he ask". `origin` answers "did he ask" and nothing else. A
 * surface that inferred one from the other would be making exactly the
 * claim-beyond-the-evidence the columns were added to prevent.
 *
 * Every shape here comes from `@syl/shared/types`, generated from
 * `shared/openapi.yaml`. Nothing in this file describes a payload.
 */

import type { Reminder } from "@syl/shared/types";

import type { Tone } from "../../ui/Badge";

/**
 * What a row's `origin` tells us, once — and only once — it has been read
 * against the possibility that it says nothing at all.
 *
 * `unrecorded` is a third thing, not a shade of the other two. Reminders
 * written before the column existed have a null origin and were deliberately
 * NOT backfilled: a guessed provenance is worse than an admitted gap. Folding
 * them into `his` would credit him with asking for things he never asked for;
 * folding them into `hers` would credit her with noticing things she never
 * noticed. Both are inventions, and one of them is the original defect.
 */
export type Provenance = "hers" | "his" | "unrecorded";

/**
 * Exhaustive by construction: a provenance added here without a label and a
 * tone fails typecheck rather than rendering as a blank chip.
 */
const PROVENANCE_SET: Record<Provenance, true> = {
  hers: true,
  his: true,
  unrecorded: true,
};

// Safe: the keys of an exhaustive `Record<Provenance, …>`.
export const PROVENANCES = Object.keys(PROVENANCE_SET) as readonly Provenance[];

export function provenanceOf(reminder: Reminder): Provenance {
  switch (reminder.origin) {
    case "she_noticed":
      return "hers";
    case "he_asked":
      return "his";
    default:
      // Including a row that has a `because` but no `origin`. Prose is not
      // evidence of who asked, and reading one out of the other here is the
      // mistake rather than the fix.
      return "unrecorded";
  }
}

const PROVENANCE_LABEL: Record<Provenance, string> = {
  // Named from his side of the conversation, because he is the one scanning.
  hers: "Syl noticed",
  his: "you asked",
  /**
   * A statement about the RECORD, never about her.
   *
   * `syl-91z`: "nothing to show" and "failed to show" must never look alike,
   * and there is a third thing here that must not look like either. "No reason
   * given" would read as Syl having declined to explain herself; "missing"
   * would read as a bug. The truth is duller and worth saying exactly: nobody
   * was keeping the answer when this row was written.
   */
  unrecorded: "before this was recorded",
};

export function provenanceLabel(provenance: Provenance): string {
  return PROVENANCE_LABEL[provenance];
}

const PROVENANCE_TONE: Record<Provenance, Tone> = {
  /**
   * The only one that carries any emphasis, and it is `accent` rather than
   * `warn`: these are the rows he is here to find, not rows that are wrong.
   */
  hers: "accent",
  // He asked for it. Chipping it in colour would drown the signal above.
  his: "muted",
  // Deliberately not `fail` and not `warn`. An old row is not an error, and a
  // surface that reddens the past is a surface that lies about it.
  unrecorded: "muted",
};

export function provenanceTone(provenance: Provenance): Tone {
  return PROVENANCE_TONE[provenance];
}

/**
 * The recorded reason, or null when there is genuinely nothing recorded.
 *
 * Returns null rather than a dash or a sentence: how to say nothing is the
 * caller's decision, and a model that hands back "no reason given" has already
 * made the wrong one on their behalf.
 */
export function reasonOf(reminder: Reminder): string | null {
  const because = reminder.because?.trim() ?? "";
  return because === "" ? null : because;
}

export interface ProvenanceSummary {
  readonly total: number;
  /** The ones she offered unprompted. The number he acts on. */
  readonly hers: number;
  readonly his: number;
  readonly unrecorded: number;
}

export function summariseProvenance(items: readonly Reminder[]): ProvenanceSummary {
  let hers = 0;
  let his = 0;
  let unrecorded = 0;

  for (const reminder of items) {
    switch (provenanceOf(reminder)) {
      case "hers":
        hers += 1;
        break;
      case "his":
        his += 1;
        break;
      default:
        unrecorded += 1;
    }
  }

  return { total: items.length, hers, his, unrecorded };
}

/**
 * One sentence, leading with the count that lets him object to a pattern.
 *
 * "She thought of these four" is the thought `SOUL.md` promises he can have and
 * currently cannot: he cannot tell her to stop making a kind of suggestion he
 * dislikes if he cannot see how many of them there are.
 */
export function summaryHeadline(summary: ProvenanceSummary): string {
  if (summary.total === 0) {
    // Not "none of these are hers" — an empty page is not a statement about
    // her behaviour, and phrasing it as one would be a finding invented out
    // of no data.
    return "No reminders.";
  }

  const hers = summary.hers === 0 ? "none" : `${summary.hers}`;
  const noun = summary.total === 1 ? "reminder" : "reminders";
  const tail =
    summary.unrecorded === 0 ? "" : ` ${summary.unrecorded} predate the record and say nothing.`;

  return `${summary.total} ${noun}, ${hers} Syl thought of herself.${tail}`;
}

/** Soonest first. What is about to happen matters more than what is filed. */
export function sortReminders(items: readonly Reminder[]): readonly Reminder[] {
  return [...items].sort((a, b) => Date.parse(a.nextFireAt) - Date.parse(b.nextFireAt));
}
