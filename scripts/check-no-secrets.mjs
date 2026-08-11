#!/usr/bin/env node
/**
 * Refuse to run if key material is TRACKED by git.
 *
 * `.gitignore` is not a guard, it is a default. `git add -f` walks past it, a
 * key with a new name walks past a filename rule, and neither notices a key
 * PASTED INTO a config file — which is the likeliest way this actually happens,
 * because the launchd plist Syl installs genuinely does contain the `.p8`.
 *
 * The stakes are specific rather than generic. An APNs auth key lets whoever
 * holds it push to every app in the team, and Apple's limit is TWO KEYS PER
 * TEAM — so a leak is both dangerous and expensive to remediate, since you
 * cannot simply mint a replacement and move on.
 *
 * And a committed secret is not undone by deleting it: it stays in history, on
 * every clone, and on GitHub. The only honest remedy is rotation. So this has
 * to fail BEFORE the commit is useful, not after somebody notices.
 *
 * Checks tracked files two ways, because either alone is porous:
 *   - by extension  (.p8 .p12 .cer .mobileprovision .keystore)
 *   - by CONTENT    (a PEM private-key header in any tracked text file)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const FORBIDDEN_EXTENSIONS = new Set([".p8", ".p12", ".cer", ".mobileprovision", ".keystore"]);

/** A PEM private key of any flavour: PKCS#8, RSA, EC, OpenSSH. */
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;

/**
 * Files allowed to mention a private-key header.
 *
 * Deliberately tiny and explicit. A pattern-based exemption ("anything under
 * tests/") is how a real key eventually lands in a fixture and nobody hears
 * about it.
 */
const ALLOWED = new Set([
  // Three test files embed a THROWAWAY EC key so the APNs signer can be
  // exercised without a real one. Checked on 2026-08-09: none of them contains
  // the Commander's actual key — compared against it directly, not eyeballed.
  //
  // Listed one by one rather than as `tests/**`, because a pattern exemption is
  // exactly how a real key eventually lands in a fixture and nobody hears about
  // it. Adding a file here should feel like a decision.
  //
  // The residual risk is real and worth naming: a real key pasted INTO one of
  // these three would pass. `syl-key1` proposes generating the test key at
  // runtime instead, which removes the PEM literals and lets this list go back
  // to empty.
  "backend/tests/unit/apns-service.test.ts",
  "backend/tests/integration/launchd-entrypoint.test.ts",
  "backend/tests/unit/reminder-delivery-job.test.ts",
]);

let tracked;
try {
  tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  // Not a git checkout (a tarball, a Docker context). Nothing to check.
  process.exit(0);
}

const byExtension = tracked.filter((f) => FORBIDDEN_EXTENSIONS.has(extname(f).toLowerCase()));

const byContent = [];
for (const file of tracked) {
  if (ALLOWED.has(file)) continue;
  if (FORBIDDEN_EXTENSIONS.has(extname(file).toLowerCase())) continue;
  const full = join(root, file);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    continue; // deleted but still in the index
  }
  // A private key is small. Skipping large files keeps this fast and cannot
  // hide one.
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    continue; // binary or unreadable
  }
  if (PRIVATE_KEY_HEADER.test(text)) byContent.push(file);
}

if (byExtension.length > 0 || byContent.length > 0) {
  console.error(
    [
      "",
      "[syl] KEY MATERIAL IS TRACKED BY GIT. Stopping.",
      "",
      ...byExtension.map((f) => `    ${f}  (forbidden extension)`),
      ...byContent.map((f) => `    ${f}  (contains a PEM private-key header)`),
      "",
      "  Untrack it before committing:",
      "",
      "    git rm --cached <file>",
      "",
      "  If it has ALREADY been committed, removing it now is not enough — it",
      "  stays in history, in every clone, and on GitHub. ROTATE THE KEY.",
      "",
      "  For an APNs key that is worse than usual: Apple allows only TWO PER",
      "  TEAM, so rotation costs you one of two slots.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
