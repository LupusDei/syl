import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * The marker that says this PROCESS has already built the backend.
 *
 * `process.env` rather than a module-level flag on purpose: vitest gives each
 * test file its own module registry even when the files share a worker, so a
 * `let built = false` resets between files and would build twice anyway. The
 * environment is one object per process and survives the reset.
 */
const MARKER = "SYL_TEST_BACKEND_BUILT";

/**
 * Build `backend/dist`, once per test process.
 *
 * Two files run the built output — `service-lifecycle.test.ts`, because a
 * signal handler is process-level by definition, and `launchd-entrypoint.test.ts`,
 * because the script launchd runs deliberately refuses to start from `tsx`.
 * Both used to build unconditionally in their own `beforeAll`, so the heavy
 * pass paid for two identical builds of the same tree.
 *
 * **Still unconditional per RUN, which is the invariant that matters.** The
 * conditional both files started with was `if (!existsSync(dist)) build()`, and
 * it cost a ten-failure run that looked like a regression in the service: a
 * migration had been renumbered, the old filename was still sitting in `dist`,
 * and the built service refused to start with "Two migrations claim version
 * 15". A fresh `vitest run` is a fresh process and therefore a fresh build; all
 * this skips is the SECOND build inside one run, of a tree that cannot have
 * changed since the first.
 */
export function buildBackendOnce(): void {
  if (process.env[MARKER] === "1") return;
  execFileSync("npm", ["run", "build", "-w", "backend"], { cwd: repoRoot, stdio: "inherit" });
  process.env[MARKER] = "1";
}
