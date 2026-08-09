#!/usr/bin/env node
/**
 * Refuse to run on the wrong Node major.
 *
 * This exists because the failure it prevents is silent, not loud. On Node 20
 * the `undici` that ships with the frontend toolchain throws at import time
 * (`webidl.util.markAsUncloneable is not a function` — a Node 22 API). Vitest
 * reports that as an "unhandled error" rather than a failure, so the run looks
 * green while whole test FILES never execute.
 *
 * Measured on the same commit:
 *
 *   Node 20.19.6   15 files / 233 tests / 6 unhandled errors
 *   Node 22.23.1   21 files / 272 tests / 0 errors
 *
 * Six files and thirty-nine tests silently did not run, and nothing said so.
 * A green suite that quietly skips a third of its files is worse than a red
 * one, because a red one gets fixed.
 *
 * `.nvmrc` and `engines` both already pin 22. Neither is enforced when a shell
 * simply resolves an older `node` first, which is the actual situation on this
 * machine. See `syl-2yb`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const required = Number(readFileSync(join(here, "..", ".nvmrc"), "utf8").trim().split(".")[0]);
const actual = Number(process.versions.node.split(".")[0]);

if (Number.isNaN(required)) {
  console.error("[syl] .nvmrc does not begin with a major version; cannot check Node.");
  process.exit(1);
}

if (actual < required) {
  console.error(
    [
      "",
      `[syl] Node ${process.versions.node} is too old — this repo requires Node ${required}.`,
      "",
      "  Two different failures, and this stops both:",
      "",
      "  RUNNING her  — `node:sqlite` does not exist before Node 22, so anything",
      "                 touching the store dies with ERR_UNKNOWN_BUILTIN_MODULE.",
      "                 The Commander hit this on `npm run pair`, and the error",
      "                 named a module rather than a cause.",
      "  TESTING her  — worse, because it is SILENT: whole test files fail to",
      "                 import and vitest reports them as unhandled errors rather",
      "                 than failures. The run looks green while dozens of tests",
      "                 never execute.",
      "",
      "  Fix:  nvm use            (reads .nvmrc)",
      `  or:   nvm install ${required}`,
      "",
    ].join("\n"),
  );
  process.exit(1);
}
