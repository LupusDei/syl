import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, loadQuietHours } from "../../config.js";
import {
  deploy,
  snapshotFromHealth,
  UNREACHABLE,
  type DeployEffects,
  type DeployEvent,
  type DeployOutcome,
  type HealthSnapshot,
} from "../deploy.js";
import {
  decideDeploy,
  judgeChecks,
  parseCheckRuns,
  parseRepoSlug,
  shouldClearProbation,
  type ChecksVerdict,
  type GateDecision,
} from "../deploy-gate.js";
import {
  defaultDeployStatePath,
  readDeployState,
  rememberFailure,
  writeDeployState,
  type DeployState,
} from "../deploy-state.js";
import { createLogger, type Logger } from "../logging.js";

/**
 * `npm run deploy`, and the same command as the unattended `com.jmm.syl.update`
 * job.
 *
 * ## One path, one gate
 *
 * This is deliberately a single entry point rather than a manual command and an
 * automatic one. Everything that replaces Syl's running code goes through
 * `decideDeploy`, and no flag here turns the CI requirement off — `--unattended`
 * only makes the run *stricter* (it also respects quiet hours and refuses to
 * retry a commit that already failed). The Commander's direction is that Syl may
 * eventually update herself; she is not being given that now, and the way to
 * make it survivable later is that there is exactly one door and it is locked
 * from the same side for everybody.
 *
 * ## Thin on purpose
 *
 * Every decision lives in `ops/deploy.ts` and `ops/deploy-gate.ts`, behind
 * injected seams, and is tested without a network, a launchd job or a running
 * service. What is left here is the plumbing that cannot be tested without the
 * machine: git, npm, launchctl, `gh`, and the HTTP probe. Same split as
 * `syl-watchdog.sh` over `ops/launchd.ts`.
 *
 * Usage:
 *   npm run deploy                    # deploy origin/main, if its checks passed
 *   npm run deploy -- --unattended    # what the launchd job runs
 *   npm run deploy -- --dry-run       # say what it would do, touch nothing
 *   npm run deploy -- --retry-failed  # retry a commit that failed before
 *   npm run deploy -- --commit <sha>  # a specific commit, still gated
 */

/** Exit codes. `1` is "did not deploy"; `70` is "she may be down". */
const EXIT_OK = 0;
const EXIT_DID_NOT_DEPLOY = 1;
const EXIT_SOFTWARE = 70;
const EXIT_CONFIG = 78;

interface Args {
  readonly unattended: boolean;
  readonly dryRun: boolean;
  readonly retryFailed: boolean;
  readonly allowWithoutRollback: boolean;
  readonly commit: string | null;
}

export function parseArgs(argv: readonly string[]): Args {
  let unattended = false;
  let dryRun = false;
  let retryFailed = false;
  let allowWithoutRollback = false;
  let commit: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--unattended":
        unattended = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--retry-failed":
        retryFailed = true;
        break;
      case "--allow-without-rollback":
        allowWithoutRollback = true;
        break;
      case "--commit": {
        const value = argv[i + 1];
        if (value === undefined) throw new Error("--commit needs a sha.");
        commit = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument ${String(flag)}. See the header of ops/cli/deploy.ts.`);
    }
  }

  return { unattended, dryRun, retryFailed, allowWithoutRollback, commit };
}

/** The repository root: three directories up from `dist/ops/cli/`. */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A verify run is the long pole: the whole suite, on an Intel iMac.
    timeout: 30 * 60 * 1000,
  }).trim();
}

/**
 * `npm`, found next to the `node` that is running this.
 *
 * launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, so
 * `npm` is frequently not on the path — the same trap `claude-bin.ts` and
 * `syl-service.sh` already document. Whatever node we were started with has an
 * npm beside it.
 */
function npmBin(): string {
  const beside = join(dirname(process.execPath), "npm");
  return existsSync(beside) ? beside : "npm";
}

interface Machine {
  readonly root: string;
  readonly healthUrl: string;
  readonly label: string;
  readonly distDir: string;
  readonly savedDistDir: string;
}

async function probeHealth(url: string, timeoutMs = 5_000): Promise<HealthSnapshot> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return UNREACHABLE;
    return snapshotFromHealth(await response.json());
  } catch {
    // Connection refused, DNS, timeout, unparseable body — all the same answer:
    // nothing that can be believed came back.
    return UNREACHABLE;
  }
}

function effects(machine: Machine, logger: Logger): DeployEffects {
  const git = (...args: string[]): string => run("git", ["-C", machine.root, ...args], machine.root);

  return {
    fetch: async () => {
      git("fetch", "--prune", "origin");
    },
    resolve: async (ref) => {
      try {
        return git("rev-parse", "--verify", `${ref}^{commit}`);
      } catch {
        return null;
      }
    },
    isDirty: async () => git("status", "--porcelain") !== "",
    currentBranch: async () => {
      const branch = git("rev-parse", "--abbrev-ref", "HEAD");
      return branch === "HEAD" ? null : branch;
    },
    isAncestor: async (ancestor, descendant) => {
      try {
        git("merge-base", "--is-ancestor", ancestor, descendant);
        return true;
      } catch {
        return false;
      }
    },
    // `reset --hard` rather than `checkout`, and the same call in both
    // directions. `checkout <sha>` would detach HEAD, leaving `main` behind and
    // the next deploy comparing against the wrong ref; `merge --ff-only` cannot
    // go backwards, which is exactly what a rollback needs. The tree is known
    // clean — the deploy refuses otherwise — and `reset --hard` does not touch
    // untracked files, so nothing unversioned is at risk.
    checkout: async (commit) => {
      git("reset", "--hard", "--quiet", commit);
    },
    migrationsBetween: async (from, to) => {
      const output = git(
        "diff",
        "--name-only",
        "--diff-filter=A",
        from,
        to,
        "--",
        "backend/src/migrations",
      );
      return output === "" ? [] : output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    },
    verify: async () => {
      run(npmBin(), ["run", "verify"], machine.root);
    },
    build: async () => {
      run(npmBin(), ["run", "build"], machine.root);
    },
    saveDist: async () => {
      if (!existsSync(machine.distDir)) return false;
      rmSync(machine.savedDistDir, { recursive: true, force: true });
      cpSync(machine.distDir, machine.savedDistDir, { recursive: true });
      return true;
    },
    restoreDist: async () => {
      if (!existsSync(machine.savedDistDir)) {
        throw new Error(`there is no saved build at ${machine.savedDistDir}`);
      }
      rmSync(machine.distDir, { recursive: true, force: true });
      cpSync(machine.savedDistDir, machine.distDir, { recursive: true });
    },
    restart: async () => {
      run("/bin/launchctl", ["kickstart", "-k", `gui/${String(userInfo().uid)}/${machine.label}`], machine.root);
    },
    probe: async () => probeHealth(machine.healthUrl),
    now: () => Date.now(),
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    log: (event: DeployEvent) => {
      logger.log(event.level, event.event, event.detail === undefined ? {} : { detail: event.detail });
      process.stdout.write(
        `  ${event.event}${event.detail === undefined ? "" : `  ${event.detail}`}\n`,
      );
    },
  };
}

/**
 * Ask GitHub about a commit's checks.
 *
 * `gh` is the Commander's own authenticated CLI, so nothing here handles a
 * token. Every failure — no `gh`, no network, rate limited, a 404 from a
 * mistyped slug — comes back as `unknown`, which the gate treats as "do not
 * deploy". That is the whole posture: we could not ask, so the answer is not
 * yes.
 */
export function fetchChecks(slug: string, commit: string, cwd: string): ChecksVerdict {
  let body: unknown;
  try {
    const output = run("gh", ["api", `repos/${slug}/commits/${commit}/check-runs?per_page=100`], cwd);
    body = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { state: "unknown", detail: `could not ask GitHub: ${detail.slice(0, 300)}` };
  }

  try {
    return judgeChecks(parseCheckRuns(body), { required: REQUIRED_CHECKS });
  } catch (error) {
    return {
      state: "unknown",
      detail: `GitHub answered something unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The checks that must exist and pass.
 *
 * `verify` is `ci.yml`'s job. It runs on every push to `main` with no path
 * filter, so a commit that does not have it has not been tested at all. The iOS
 * jobs are deliberately not required: their workflow is path-filtered, so a
 * backend-only commit legitimately never runs them, and requiring them would
 * deadlock every deploy this repository makes.
 */
export const REQUIRED_CHECKS: readonly string[] = ["verify"];

/** How long a freshly deployed build stays on probation. */
export const PROBATION_MS = 30 * 60 * 1000;

function describe(decision: GateDecision): string {
  switch (decision.action) {
    case "deploy":
      return `deploying ${decision.commit.slice(0, 7)}`;
    case "rollback":
      return `rolling back ${decision.from.slice(0, 7)} -> ${decision.to.slice(0, 7)}: ${decision.detail}`;
    case "wait":
      return `not deploying (${decision.reason}): ${decision.detail}`;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const home = homedir();
  // Deliberately NOT `loadConfig`. That validates the whole service
  // configuration — APNs credentials, the database path, the memory directory —
  // and refuses to start over any of it. None of that is this command's
  // business, and a deploy that cannot run because a push variable is missing
  // would be a strange way to lose the ability to fix the push variable.
  const port = Number(process.env.SYL_PORT ?? DEFAULT_PORT);
  const quietHours = loadQuietHours(process.env);
  const logDirectory = process.env.SYL_LOG_DIR ?? join(home, "Library", "Logs", "Syl");

  const machine: Machine = {
    root,
    healthUrl: `http://127.0.0.1:${String(port)}/api/v1/health`,
    label: process.env.SYL_CORE_LABEL ?? "com.jmm.syl.core",
    distDir: join(root, "backend", "dist"),
    // Beside `dist/`, not inside it: a build writes into `dist/` and would
    // otherwise copy the previous build into the new one, recursively.
    savedDistDir: join(root, "backend", ".dist-previous"),
  };

  const logger = createLogger({ directory: logDirectory });
  const statePath = process.env.SYL_DEPLOY_STATE ?? defaultDeployStatePath(home);
  let state: DeployState = readDeployState(statePath, (warning) => {
    logger.warn("deploy.state_unreadable", { detail: warning });
  });

  const effect = effects(machine, logger);

  let slug: string | null = null;
  try {
    slug = parseRepoSlug(run("git", ["-C", root, "remote", "get-url", "origin"], root));
  } catch {
    slug = null;
  }
  if (slug === null) {
    logger.error("deploy.no_remote", { detail: "cannot work out the GitHub repository from `origin`" });
    process.stderr.write("[syl] cannot work out the GitHub repository from `git remote get-url origin`.\n");
    logger.close();
    return EXIT_CONFIG;
  }

  try {
    await effect.fetch();
  } catch (error) {
    // A failed fetch is not fatal: it only means the target is whatever was
    // already fetched. The gate still decides, and a stale target that has
    // green checks is a perfectly safe thing to deploy.
    logger.warn("deploy.fetch_failed", { detail: error instanceof Error ? error.message : String(error) });
  }

  const target = args.commit ?? (await effect.resolve("origin/main"));
  const snapshot = await effect.probe();
  const checks =
    target === null
      ? ({ state: "unknown", detail: "no target commit to ask about" } as ChecksVerdict)
      : fetchChecks(slug, target, root);

  const decision = decideDeploy(
    {
      target,
      running: snapshot.build?.commit ?? null,
      healthy: snapshot.reachable && snapshot.status !== "down",
      turnsInFlight: snapshot.turnsInFlight,
      checks,
      now: new Date(),
      failedCommits: state.failedCommits,
      probation: state.probation,
    },
    {
      respectQuietHours: args.unattended,
      quietHours,
      allowPreviouslyFailed: args.retryFailed && !args.unattended,
    },
  );

  process.stdout.write(`[syl] ${describe(decision)}\n`);
  logger.info("deploy.decision", { action: decision.action, detail: describe(decision) });

  if (args.dryRun) {
    logger.close();
    return decision.action === "deploy" ? EXIT_OK : EXIT_DID_NOT_DEPLOY;
  }

  let exit = EXIT_DID_NOT_DEPLOY;

  if (decision.action === "rollback") {
    // A build that was deployed minutes ago and has stopped answering. The
    // deploy's own soak window is long gone; this is the second net.
    try {
      await effect.restoreDist();
      await effect.checkout(decision.to);
      await effect.restart();
      // "Restored the files" is not the claim worth making. Wait until she is
      // actually answering as the previous build, and say so either way — this
      // runs at 3am and the log line is the only evidence anybody will have.
      const deadline = Date.now() + 120_000;
      let back = false;
      while (Date.now() < deadline && !back) {
        await effect.sleep(3_000);
        const after = await effect.probe();
        back = after.reachable && after.status !== "down";
      }
      logger.error("deploy.probation_rollback", {
        from: decision.from,
        to: decision.to,
        answering: back,
      });
      if (!back) {
        process.stderr.write("[syl] ROLLED BACK and she is STILL NOT ANSWERING. Syl is down.\n");
      }
      state = rememberFailure({ ...state, probation: null }, decision.from);
      exit = EXIT_SOFTWARE;
    } catch (error) {
      logger.error("deploy.probation_rollback_failed", {
        detail: error instanceof Error ? error.message : String(error),
      });
      exit = EXIT_SOFTWARE;
    }
  } else if (decision.action === "deploy") {
    const outcome: DeployOutcome = await deploy(effect, {
      commit: decision.commit,
      ...(args.allowWithoutRollback ? { allowWithoutRollback: true } : {}),
    });
    exit = report(outcome, logger);

    if (outcome.kind === "deployed" && outcome.previousCommit !== null) {
      // No probation without something to roll back TO. A marker whose
      // `previousCommit` is the build it is watching would, on firing, restore
      // the very thing that failed.
      state = {
        ...state,
        probation: {
          commit: outcome.commit,
          previousCommit: outcome.previousCommit,
          expiresAt: new Date(Date.now() + PROBATION_MS).toISOString(),
        },
      };
    } else if (outcome.kind === "rolled-back" || outcome.kind === "rollback-failed") {
      state = rememberFailure({ ...state, probation: null }, outcome.commit);
    }
  } else if (shouldClearProbation(state.probation, {
    healthy: snapshot.reachable && snapshot.status !== "down",
    running: snapshot.build?.commit ?? null,
    now: new Date(),
  })) {
    logger.info("deploy.probation_cleared", { commit: state.probation?.commit ?? "" });
    state = { ...state, probation: null };
  }

  state = {
    ...state,
    lastRun: { at: new Date().toISOString(), action: decision.action, detail: describe(decision) },
  };
  writeDeployState(statePath, state);
  logger.close();
  return exit;
}

function report(outcome: DeployOutcome, logger: Logger): number {
  switch (outcome.kind) {
    case "deployed":
      process.stdout.write(`[syl] deployed ${outcome.commit.slice(0, 7)}.\n`);
      if (outcome.migrations.length > 0) {
        process.stdout.write(
          `[syl] ${String(outcome.migrations.length)} migration(s) applied. A rollback would NOT undo them.\n`,
        );
      }
      logger.info("deploy.deployed", { commit: outcome.commit });
      return EXIT_OK;
    case "up-to-date":
      return EXIT_OK;
    case "refused":
      process.stderr.write(`[syl] refused (${outcome.reason}): ${outcome.detail}\n`);
      logger.warn("deploy.refused", { reason: outcome.reason, detail: outcome.detail });
      return EXIT_DID_NOT_DEPLOY;
    case "rolled-back":
      process.stderr.write(
        `[syl] ROLLED BACK to ${outcome.previousCommit.slice(0, 7)} (${outcome.failure}). She is answering.\n`,
      );
      if (outcome.migrations.length > 0) {
        process.stderr.write(
          `[syl] ${String(outcome.migrations.length)} migration(s) had already run. The CODE is back; the SCHEMA is not.\n`,
        );
      }
      logger.error("deploy.rolled_back", { commit: outcome.commit, to: outcome.previousCommit });
      return EXIT_SOFTWARE;
    case "rollback-failed":
      process.stderr.write(`[syl] ROLLBACK FAILED. ${outcome.detail}\n`);
      logger.error("deploy.rollback_failed", { detail: outcome.detail });
      return EXIT_SOFTWARE;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`[syl] deploy failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = EXIT_SOFTWARE;
  });
