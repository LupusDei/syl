#!/usr/bin/env node
/**
 * Promote three of his memories to standing instructions. `syl-024.5`.
 *
 * One-shot, against one database, by explicit id. **Not a migration**: a migration
 * would put the Commander's memories in git and would run against every database
 * that ever exists, and this is a decision about three rows in his.
 *
 * ## What he approved, and what he refused
 *
 * The proposal offered four. He took three and rejected the fourth himself:
 *
 * > *"The morning brief and sardonic humor are good to keep. Same with #4 unprompted
 * > reminders. #3 is merely a render preference and not an instruction."*
 *
 * `Prefers depictions with a face` stays a `fact`, and his reasoning is the rule the
 * whole epic turns on: a preference discovered inside the likeness search belongs to
 * that search, which TERMINATES. A standing instruction is the bond, which does not.
 * The two were being filed together and that was the original complaint.
 *
 * ## Why this only changes `kind`
 *
 * The plan proposed also adding an edge to his person node. It does not, for two
 * reasons found while checking rather than while writing:
 *
 * 1. **All three already carry `observed stated` edges** from the conversation source,
 *    so provenance — who said it, and where it came from — is already intact.
 * 2. **`WORKING_MEMORY_PINNED_KINDS` selects by KIND, not by edge**, so the person link
 *    is not needed for a standing order to reach the document she reads.
 *
 * And the deciding reason: an observed edge may only carry `stated`
 * (`OBSERVED_RELATIONS`), so the proposed `about` edge would have to be INFERRED —
 * and **constraint 6 means an inferred edge can never be deleted, only demoted.**
 * Writing an irreversible row for a benefit nothing has demonstrated is the wrong
 * trade. A `kind` is a column and can be set back; an edge cannot be unmade. If
 * traversal from his node turns out to matter, it can be added later, which is not
 * true in the other direction.
 *
 * ## Usage
 *
 *     node backend/scripts/promote-standing-instructions.mjs            # shows, changes nothing
 *     node backend/scripts/promote-standing-instructions.mjs --apply    # writes
 *
 * It refuses to run against anything but the id list below, prints every row before
 * and after, and is idempotent — a row already `instruction` is reported and skipped.
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Exactly the three he approved, by full id. Nothing is matched by text. */
const APPROVED = [
  {
    id: "syl:memory_node:019ff115-b065-7000-899a-dc4207a6c4ea",
    why: "Morning briefing routine — \"you are supposed to review my reminders goals and previous todos\", plus him enforcing it afterwards.",
  },
  {
    id: "syl:memory_node:019ffb38-6cd7-7000-a41e-b9afde060fe1",
    why: "Sardonic humour — \"boost its relevance so it doesn't fade into nothingness\". A direct order about her own persistence, and the reason this bead exists.",
  },
  {
    id: "syl:memory_node:019fecb2-761a-7000-a743-a96c5e18396f",
    why: "Unprompted practical reminders — \"that kind of stuff is perfect and why I am creating you\".",
  },
];

const DB = process.env["SYL_DB"] ?? join(homedir(), ".syl", "syl.db");
const apply = process.argv.includes("--apply");

if (apply) {
  // Before anything, and unconditionally. The rows are recoverable from this file
  // and from nowhere else — there is no second copy of his memory.
  const backup = `${DB}.before-syl-024.5`;
  copyFileSync(DB, backup);
  console.log(`[syl] backed up to ${backup}\n`);
}

const db = new DatabaseSync(DB, { readOnly: !apply });
const read = db.prepare("SELECT id, kind, label, body FROM memory_nodes WHERE id = ?");

let changed = 0;
let already = 0;

for (const { id, why } of APPROVED) {
  const row = read.get(id);

  if (row === undefined) {
    console.error(`[syl] NOT FOUND, refusing to guess: ${id}`);
    process.exitCode = 1;
    continue;
  }
  if (row.kind === "instruction") {
    console.log(`[syl] already an instruction, skipping: ${row.label}\n`);
    already += 1;
    continue;
  }
  if (row.kind !== "fact") {
    // Every approved row was a `fact`. Anything else means the graph moved under
    // this script, and guessing would be worse than stopping.
    console.error(`[syl] expected 'fact', found '${row.kind}': ${id}`);
    process.exitCode = 1;
    continue;
  }

  console.log(`  ${row.label}`);
  console.log(`    ${String(row.body ?? "").replaceAll("\n", " ").slice(0, 160)}`);
  console.log(`    why: ${why}`);
  console.log(`    kind: ${row.kind} -> instruction`);

  if (apply) {
    db.prepare("UPDATE memory_nodes SET kind = ?, updated_at = ? WHERE id = ?").run(
      "instruction",
      new Date().toISOString(),
      id,
    );
    const after = read.get(id);
    console.log(`    confirmed: ${String(after.kind)}`);
    changed += 1;
  }
  console.log("");
}

console.log(
  apply
    ? `[syl] ${String(changed)} promoted, ${String(already)} already done. Nothing was deleted.`
    : `[syl] dry run — nothing written. Re-run with --apply.`,
);
