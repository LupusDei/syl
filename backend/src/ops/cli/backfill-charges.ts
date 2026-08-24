/**
 * Correct what his old records say a render cost.
 *
 *   npm run backfill:charges              a dry run: prints before and after, writes nothing
 *   npm run backfill:charges -- --write   the same run, and it writes
 *
 * **Nothing happens without `--write`, and `--write` is his decision.** Fixing
 * a defect in our code and editing his past are different acts; `syl-o0vy`
 * fixed the first and this waits on the second. See
 * `render/backfill-charges.ts` for what it will and will not do.
 *
 * Every sidecar it touches is copied to `~/.syl/render-backups/<timestamp>/`
 * and read back byte-identical **before a single byte is written anywhere**. A
 * backup taken after a write holds the damage.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  applyBackfill,
  needsBackfill,
  planBackfill,
  type BackfillIo,
  type RenderChange,
} from "../../render/backfill-charges.js";
import { RenderService } from "../../render/render-service.js";
import { RunwayClient } from "../../render/runway.js";
import { studioAt } from "../../render/studio.js";

/**
 * The secret, from the file the running service reads.
 *
 * Never printed, never logged, never put in an error message — the same rule
 * `runway.ts` keeps for the header it sends. The environment wins if it is set,
 * so an operator can supply one without editing the plist; otherwise this asks
 * the deployment where the deployment keeps it.
 */
function runwaySecret(): string {
  const fromEnv = process.env["RUNWAYML_API_SECRET"]?.trim() ?? "";
  if (fromEnv !== "") return fromEnv;

  const plist = join(homedir(), "Library", "LaunchAgents", "com.jmm.syl.core.plist");
  try {
    const printed = execFileSync("/usr/bin/plutil", ["-p", plist], { encoding: "utf8" });
    return /"RUNWAYML_API_SECRET"\s*=>\s*"([^"]+)"/u.exec(printed)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** `240 → 120`, or `240 → 120 (240 unchanged)`, for a human to read. */
function money(change: RenderChange): string {
  const before = change.before === null ? "unpriced" : String(change.before);
  const arrow = change.before === change.after ? "=" : "→";
  return `${before.padStart(6)} ${arrow} ${String(change.after).padEnd(6)}`;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const home = join(homedir(), ".syl");
  const studio = studioAt(home);

  const secret = runwaySecret();
  if (secret === "") {
    console.error(
      "\n  No RUNWAYML_API_SECRET, from the environment or from com.jmm.syl.core.plist.\n" +
        "  Nothing has been read and nothing has been written.\n",
    );
    process.exitCode = 1;
    return;
  }

  // `backend: null` deliberately: this service is only ever asked to READ the
  // sidecars, and one that could not start a render cannot start one by mistake.
  const renders = new RenderService({ studio, backend: null });
  const records = renders.list().filter(needsBackfill);

  console.log(`\n  ${write ? "WRITING" : "DRY RUN — nothing will be written"}`);
  console.log(`  renders that did not finish: ${String(records.length)}\n`);
  if (records.length === 0) return;

  const client = new RunwayClient({ secret });
  const plan = await planBackfill({ records, task: async (id) => client.task(id) });

  if (!plan.ok) {
    console.error("  STOPPED. Something here is not understood, so nothing was written:\n");
    for (const surprise of plan.surprises) console.error(`    - ${surprise}`);
    console.error("");
    process.exitCode = 1;
    return;
  }

  let overstated = 0;
  for (const change of plan.changes) {
    console.log(`  ${money(change)}  ${change.name}`);
    for (const part of change.parts) {
      const recorded = part.recorded === null ? "unpriced" : String(part.recorded);
      console.log(
        `           ${recorded.padStart(6)} → ${String(part.charged).padEnd(6)}  ${part.taskId}`,
      );
    }
    overstated += (change.before ?? change.after) - change.after;
  }
  console.log(`\n  overstated by ${String(overstated)} credits in total.\n`);

  if (!write) {
    console.log("  Re-run with --write to apply. Nothing has been changed.\n");
    return;
  }

  // One directory per run, so a second run never lands on the first one's
  // copies. The stamp is the run's own identity and it goes in the log.
  const vault = join(homedir(), ".syl", "render-backups", new Date().toISOString().replace(/[:.]/gu, "-"));
  mkdirSync(vault, { recursive: true });

  const io: BackfillIo = {
    readSidecar: (name) => readFileSync(studio.sidecar(name), "utf8"),
    backup: (name) => {
      const to = join(vault, basename(studio.sidecar(name)));
      // `copyFileSync` rather than writing the bytes we hold: the copy is then
      // of the FILE, and the read-back below compares the file to the file.
      copyFileSync(studio.sidecar(name), to);
      return to;
    },
    readBackup: (name) => readFileSync(join(vault, basename(studio.sidecar(name))), "utf8"),
    writeSidecar: (name, bytes) => {
      writeFileSync(studio.sidecar(name), bytes);
    },
  };

  const applied = applyBackfill(plan.changes, io);
  if (!applied.ok) {
    console.error(`\n  REFUSED. ${applied.refused}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`  backed up to ${vault}`);
  for (const name of applied.written) console.log(`  corrected     ${name}`);
  console.log(
    `\n  ${String(applied.written.length)} records corrected. The originals are in the ` +
      `directory above; put one back with cp if any of this is wrong.\n`,
  );
}

// `existsSync` on the studio root before anything else: a machine with no
// renders directory should say so rather than report zero renders, which reads
// as "nothing is wrong here".
if (!existsSync(join(homedir(), ".syl", "renders"))) {
  console.error(`\n  There is no ${join(homedir(), ".syl", "renders")} on this machine.\n`);
  process.exitCode = 1;
} else {
  await main();
}
