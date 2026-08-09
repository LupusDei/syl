#!/usr/bin/env node
/**
 * Refuse to run when a workspace's dependencies are not installed here.
 *
 * Written for the same reason as `check-node.mjs`, against the same failure
 * shape: the symptom is ABSENCE, not an error.
 *
 * npm hoists workspace dependencies into the checkout where `npm install` ran.
 * A fresh git worktree has neither its own copy nor a resolvable path to the
 * main checkout's, so `@vitejs/plugin-react` cannot be found — and vitest
 * reports that as a COLLECTION failure. Forty-one frontend test files then do
 * not appear as failures; they simply are not there. An agent reads a suite
 * that is missing a third of itself and concludes "the frontend is broken" or
 * "I broke something", and goes hunting.
 *
 * THREE agents hit this independently, each treating it as a novel local
 * problem. That repetition is the real cost — not the fix, which is one
 * command, but every agent rediscovering it from a message that names a
 * package and never names a cause.
 *
 * It compounds with the Node-major trap: together they take out most of the
 * suite with two misleading messages and no honest explanation for either.
 *
 * The Node guard is the precedent. It turned a silent, recurring, misleading
 * failure into one loud line naming the fix, and stopped that half cold. This
 * is the same treatment for the other half. See `syl-114`.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workspaces = manifest.workspaces ?? [];

/**
 * One dependency per workspace is enough.
 *
 * This is a smoke test, not an audit: if resolution works at all from a
 * workspace, `npm install` has been run here. Checking every dependency would
 * be slower and no more informative, and a partial install is not the failure
 * being guarded against.
 */
const missing = [];

for (const workspace of workspaces) {
  const workspaceRoot = join(root, workspace);
  const manifestPath = join(workspaceRoot, "package.json");
  if (!existsSync(manifestPath)) continue;

  const own = JSON.parse(readFileSync(manifestPath, "utf8"));
  const deps = Object.keys({ ...own.dependencies, ...own.devDependencies });
  if (deps.length === 0) continue;

  // Resolve as the workspace itself would, so this tests the real lookup path
  // rather than the existence of a directory.
  const require = createRequire(join(workspaceRoot, "noop.js"));
  for (const dep of deps) {
    try {
      require.resolve(dep);
    } catch {
      // `resolve` throws for a package with no main export even when it is
      // installed, so confirm against the directory before blaming the install.
      if (!existsSync(join(workspaceRoot, "node_modules", dep)) && !existsSync(join(root, "node_modules", dep))) {
        missing.push({ workspace, dep });
        break;
      }
    }
  }
}

if (missing.length > 0) {
  console.error(
    [
      "",
      "[syl] Dependencies are not installed in THIS checkout.",
      "",
      ...missing.map(({ workspace, dep }) => `  ${workspace}: cannot resolve ${dep}`),
      "",
      "  This is a hard stop rather than a warning because the failure it prevents",
      "  is SILENT: vitest cannot COLLECT a test file whose imports do not resolve,",
      "  so those files do not fail — they vanish. The run looks smaller rather",
      "  than broken, and the message names a package rather than a cause.",
      "",
      "  You are most likely in a fresh git worktree. npm hoists workspace",
      "  dependencies into the checkout where install was run, and this is not it.",
      "",
      "  Fix:  npm install        (from this checkout's root)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
