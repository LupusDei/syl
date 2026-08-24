import { usdOf } from "./credits.js";
import type { RenderRecord } from "./render-service.js";
import type { RunwayResult, RunwayTask } from "./runway.js";

/**
 * Correcting what his old records say a render cost.
 *
 * ## What this is for, and why it is not part of the fix
 *
 * `syl-o0vy` stopped the ledger inventing charges: it reads `cost.credits` off
 * the task now instead of pricing a render from our own rate card. That fixes
 * every render made from here on and touches nothing already written — a
 * sidecar with no `charged` reads its old estimate forward, which is what it
 * always was and is the number his totals have always shown.
 *
 * Four of those old numbers are known to be wrong and known by how much:
 *
 *     recorded 240 / 240 / 240 / 450        charged 120 / 120 / 0 / 0
 *
 * **Correcting them is his call and nobody else's.** Fixing a defect in our
 * code and editing his past are different acts, and the second one needs him to
 * say yes. So this exists, ready, and does nothing until it is run with
 * `--write`.
 *
 * ## The discipline, which was learned by losing something
 *
 * **Every sidecar this would touch is copied and READ BACK IDENTICAL before a
 * single byte is written.** Not backed up as it goes — all of them first, all
 * verified, and only then does anything get written. A backup taken after a
 * write holds the damage, which is the whole lesson.
 *
 * **Anything unexpected stops the entire run**, and stops it before any write
 * rather than part-way through. A backfill that silently "fixed" a record
 * nobody predicted would be worse than the overstatement it was correcting —
 * the point of this is to make a number trustworthy, and a tool that surprises
 * you cannot do that. There is deliberately no "skip the awkward one and carry
 * on": if this run is not entirely understood, it does not happen.
 *
 * ## Why the two halves are separate
 *
 * {@link planBackfill} decides and {@link applyBackfill} writes, with no I/O in
 * the first and no decisions in the second. That is what lets the dry run be
 * the *same code path* as the real one rather than a second implementation of
 * it that could disagree — the difference between `--write` and not is whether
 * the second half is called at all.
 */

/** What one generation was recorded at, and what Runway says it charged. */
export interface PartCharge {
  readonly taskId: string;
  /** The estimate the sidecar holds today. `null` where it holds none. */
  readonly recorded: number | null;
  /** What Runway says. Never a guess: a task with no cost stops the run. */
  readonly charged: number;
}

/** One record's before and after, for a human to read before saying yes. */
export interface RenderChange {
  readonly name: string;
  /** What the sidecar claims this render cost today. */
  readonly before: number | null;
  /** What it was actually charged, summed over its generations. */
  readonly after: number;
  readonly parts: readonly PartCharge[];
}

export type BackfillPlan =
  | { readonly ok: true; readonly changes: readonly RenderChange[] }
  | { readonly ok: false; readonly surprises: readonly string[] };

/**
 * Which records this is willing to touch.
 *
 * **Only the ones that did not finish.** A render that succeeded was charged
 * very close to its estimate and rewriting forty of those to move a few credits
 * is a large edit to his history for no gain — and every file touched is a file
 * that can go wrong. The renders where the rate card is *known* to be wrong are
 * exactly the ones that stopped, because a generation that failed cost nothing
 * and the estimate charged him for it in full.
 */
export function needsBackfill(record: RenderRecord): boolean {
  return record.status === "failed" || record.status === "partial";
}

/**
 * What the backfill would change, or every reason it must not run.
 *
 * Pure: it asks for charges through `task` and decides. Nothing here reads or
 * writes a file, so the decision can be tested without a disk and the dry run
 * is the real run minus the writing.
 */
export async function planBackfill(options: {
  readonly records: readonly RenderRecord[];
  readonly task: (taskId: string) => Promise<RunwayResult<RunwayTask>>;
}): Promise<BackfillPlan> {
  const changes: RenderChange[] = [];
  const surprises: string[] = [];

  for (const record of options.records.filter(needsBackfill)) {
    const parts: PartCharge[] = [];

    for (const [index, part] of record.parts.entries()) {
      // A generation that never reached Runway has nothing to ask about and
      // nothing to correct: it was not in the total before and is not now.
      if (part.taskId === null) continue;

      const answered = await options.task(part.taskId);
      if (!answered.ok) {
        // Includes a task Runway no longer knows about. That is a fact we
        // cannot recover and must not paper over, so it stops everything.
        surprises.push(
          `${record.name} part ${String(index + 1)} (${part.taskId}): ${answered.failure.message}`,
        );
        continue;
      }
      if (answered.data.charged === null) {
        surprises.push(
          `${record.name} part ${String(index + 1)} (${part.taskId}): Runway returned no cost for ` +
            `this task, and this tool will not guess at one.`,
        );
        continue;
      }
      // A record that already carries a charge was written by the fixed code
      // and is not this tool's business. Rewriting it would be the one thing
      // this must never do: overwrite an observation with a second opinion.
      if (part.charged !== null && part.charged !== answered.data.charged) {
        surprises.push(
          `${record.name} part ${String(index + 1)} (${part.taskId}): already records a charge of ` +
            `${String(part.charged)} and Runway now says ${String(answered.data.charged)}.`,
        );
        continue;
      }

      parts.push({ taskId: part.taskId, recorded: part.credits, charged: answered.data.charged });
    }

    if (parts.length === 0) continue;
    changes.push({
      name: record.name,
      before: record.credits,
      after: parts.reduce((total, part) => total + part.charged, 0),
      parts,
    });
  }

  // All of them, not the first. An operator deciding whether to run this needs
  // to see everything that is wrong at once rather than one thing per attempt.
  if (surprises.length > 0) return { ok: false, surprises };
  return { ok: true, changes };
}

/** Everything this needs from a disk, so a test can hand it something else. */
export interface BackfillIo {
  /** The sidecar's bytes, exactly as they are on disk. */
  readonly readSidecar: (name: string) => string;
  /** Put a copy somewhere safe. Answers with where it went, for the log. */
  readonly backup: (name: string, bytes: string) => string;
  /** Read the copy back OFF THE DISK. Never from memory — that proves nothing. */
  readonly readBackup: (name: string) => string;
  readonly writeSidecar: (name: string, bytes: string) => void;
}

export type BackfillOutcome =
  | { readonly ok: true; readonly written: readonly string[]; readonly backups: readonly string[] }
  | { readonly ok: false; readonly refused: string };

/**
 * Write the plan, once every sidecar it touches is safely copied.
 *
 * The order is the safety property, so it is worth stating plainly: **copy all,
 * verify all, then write.** Backing each file up immediately before its own
 * write would leave the fourth file unprotected while the fifth is being
 * verified, and a run that dies in the middle would have some records corrected
 * and some backed up and no single place holding the original of everything.
 *
 * A backup that does not read back byte-identical refuses the whole run. It is
 * the one check that cannot be skipped for convenience: without it, "there is a
 * backup" is a belief rather than a fact, and this file exists because of what
 * beliefs cost.
 */
export function applyBackfill(
  changes: readonly RenderChange[],
  io: BackfillIo,
): BackfillOutcome {
  const originals = new Map<string, string>();
  const backups: string[] = [];

  for (const change of changes) {
    const bytes = io.readSidecar(change.name);
    originals.set(change.name, bytes);

    const where = io.backup(change.name, bytes);
    let readBack: string;
    try {
      readBack = io.readBackup(change.name);
    } catch (error) {
      return {
        ok: false,
        refused:
          `The backup of ${change.name} could not be read back from ${where} ` +
          `(${error instanceof Error ? error.message : String(error)}). Nothing has been written.`,
      };
    }
    if (readBack !== bytes) {
      return {
        ok: false,
        refused:
          `The backup of ${change.name} at ${where} does not match what is on disk, so it is not ` +
          `a backup. Nothing has been written.`,
      };
    }
    backups.push(where);
  }

  const written: string[] = [];
  for (const change of changes) {
    const bytes = originals.get(change.name) ?? "";
    io.writeSidecar(change.name, corrected(bytes, change));
    written.push(change.name);
  }
  return { ok: true, written, backups };
}

/**
 * One sidecar with its charges written in, and nothing else touched.
 *
 * Re-serialised from the parsed object rather than patched as text, so the file
 * stays valid JSON — but ONLY the three fields below are set. Everything else,
 * including every field this module has never heard of, is carried across
 * exactly as it was. The prompt is the thing that must survive above all: it is
 * the reason the sidecar exists.
 */
function corrected(bytes: string, change: RenderChange): string {
  const sidecar = JSON.parse(bytes) as Record<string, unknown>;
  const byTask = new Map(change.parts.map((part) => [part.taskId, part.charged]));

  const parts = Array.isArray(sidecar["parts"]) ? sidecar["parts"] : [];
  sidecar["parts"] = parts.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const part = entry as Record<string, unknown>;
    const taskId = part["taskId"];
    if (typeof taskId !== "string" || !byTask.has(taskId)) return part;
    return { ...part, charged: byTask.get(taskId) };
  });

  sidecar["credits"] = change.after;
  sidecar["usd"] = usdOf(change.after);
  // The same shape `RenderService` writes, so a corrected file and a fresh one
  // are the same kind of file.
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}
