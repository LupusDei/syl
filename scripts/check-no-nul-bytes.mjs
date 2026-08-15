#!/usr/bin/env node
/**
 * Refuse a NUL byte in a file that is supposed to be text.
 *
 * `syl-bu1`. Two files in `backend/src/memory/` carried a literal `U+0000` —
 * `forget.ts` at offset 11833 and `metrics.ts` at 35294 — each a sentinel or
 * separator written as the BYTE instead of the escape. Identical at runtime,
 * and catastrophic to every search tool: `grep` and `rg` classify such a file
 * as binary and print **nothing**. Not "no matches" — no output at all, exiting
 * as though the question had been asked and answered.
 *
 * So a repo-wide search for `memory_vectors` silently skipped the one module
 * that hard-deletes from it, and a search for anything at all skipped the
 * module that computes the metrics we would use to notice. **Two of the eight
 * files in `memory/` were invisible, and nobody chose either.**
 *
 * ## Why this reads bytes and never searches
 *
 * artanis's first detector used `git grep -I --name-only` to list the files git
 * considers text, and subtracted. It returned empty — a clean bill of health
 * for the whole repository — and when tested against the known-bad file it said
 * NO. **A detector for this class cannot itself be a search**, because every
 * search tool has an opinion about which files it will look inside and will not
 * tell you when it has excluded one.
 *
 * This opens each file and looks for the byte. Nothing is asked for its
 * opinion.
 *
 * ## Why a DENYLIST of binary extensions, not an allowlist of text ones
 *
 * The two directions fail differently and only one of them fails safely.
 *
 * An allowlist of text extensions misses a NEW text extension silently — the
 * file is simply never scanned, which is the exact failure being guarded
 * against, rebuilt inside the guard.
 *
 * A denylist assumes text unless proven binary. A new binary format produces a
 * LOUD false positive that costs somebody one line here, and a new text format
 * is covered from the day it arrives without anyone remembering to add it.
 *
 * Loud and occasionally wrong beats silent and occasionally right.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** Formats that are legitimately full of NUL bytes. */
const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns",
  ".mp4", ".mov", ".m4a", ".mp3", ".wav",
  ".pdf", ".zip", ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".otf",
  ".car", ".xcuserstate", ".pbxproj",
]);

const files = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 256 * 1024 * 1024 })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const infected = [];
for (const file of files) {
  if (BINARY.has(extname(file).toLowerCase())) continue;
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue; // Deleted between listing and reading; not our business.
  }
  const at = bytes.indexOf(0);
  if (at >= 0) infected.push({ file, at });
}

if (infected.length > 0) {
  console.error("A text file contains a NUL byte, which makes it INVISIBLE to grep and rg.\n");
  for (const { file, at } of infected) console.error(`  ${file} @ offset ${String(at)}`);
  console.error(
    [
      "",
      "grep and rg treat such a file as binary and print NOTHING for any pattern —",
      "not 'no matches', no output at all. Every repo-wide search silently skips it.",
      "",
      "If this is a sentinel or separator, write the ESCAPE and not the byte:",
      '  "\\0"  not  a literal U+0000',
      "They are identical at runtime and only one of them is visible.",
      "",
      "If this is a new binary format, add its extension to BINARY in this file.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`[syl] no NUL bytes in ${String(files.length)} tracked files`);
