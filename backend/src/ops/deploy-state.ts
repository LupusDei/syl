import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Probation } from "./deploy-gate.js";

/**
 * What the update job remembers between runs.
 *
 * Two things, and both exist because the job runs every few minutes forever
 * with nobody watching:
 *
 * 1. **Commits a deploy has already failed on.** Without this, a commit that
 *    passes CI and then fails to come up gets deployed, rolled back, deployed,
 *    rolled back — every ten minutes, all night, restarting her each time. A
 *    rollback that keeps being undone is not a rollback.
 * 2. **Probation.** A build deployed minutes ago is still on trial: if it stops
 *    answering before the window closes, the next run of the job puts the
 *    previous one back. The deploy's own soak window covers the first ninety
 *    seconds; this covers the rest, because by then the deploy process has
 *    exited and only `KeepAlive` is left, restarting the same crash.
 *
 * Kept beside the other operational state in `~/.syl/`, not in the database:
 * the database is the thing a bad deploy may have broken, and a rollback plan
 * stored inside the casualty is not a plan.
 */

export interface DeployAttempt {
  readonly at: string;
  readonly action: string;
  readonly detail: string;
}

export interface DeployState {
  /** Commits a deploy failed on. Never retried unattended. */
  readonly failedCommits: readonly string[];
  readonly probation: Probation | null;
  readonly lastRun: DeployAttempt | null;
}

export const EMPTY_DEPLOY_STATE: DeployState = {
  failedCommits: [],
  probation: null,
  lastRun: null,
};

/**
 * How many failures to remember.
 *
 * Bounded because this file is written by an unattended job forever. Twenty is
 * far more than the number of bad commits any night can produce, and an
 * unbounded list would be a slow leak in the one file that must stay readable
 * when everything else has gone wrong.
 */
export const MAX_REMEMBERED_FAILURES = 20;

/** Where the state lives for a given home directory. */
export function defaultDeployStatePath(home: string): string {
  return join(home, ".syl", "deploy-state.json");
}

/**
 * Read the state, or start from empty.
 *
 * Never throws. A missing file is the first run; a damaged one is a file this
 * job wrote and can write again. Refusing to start because the memo is
 * unreadable would turn a cosmetic problem into "Syl is never updated again".
 * The one thing that is not done is guessing: a damaged file yields the empty
 * state, which is the cautious answer everywhere it is used — no probation to
 * act on, and no failure list, so the CI gate is what decides.
 */
export function readDeployState(path: string, onWarn?: (message: string) => void): DeployState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return EMPTY_DEPLOY_STATE;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const failed = parsed.failedCommits;
    const probation = parsed.probation;
    const lastRun = parsed.lastRun;
    return {
      failedCommits: Array.isArray(failed) ? failed.filter((c): c is string => typeof c === "string") : [],
      probation: isProbation(probation) ? probation : null,
      lastRun: isAttempt(lastRun) ? lastRun : null,
    };
  } catch (error) {
    onWarn?.(`${path} is unreadable (${error instanceof Error ? error.message : "bad JSON"}); starting fresh.`);
    return EMPTY_DEPLOY_STATE;
  }
}

function isProbation(value: unknown): value is Probation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commit === "string" &&
    typeof record.previousCommit === "string" &&
    typeof record.expiresAt === "string"
  );
}

function isAttempt(value: unknown): value is DeployAttempt {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === "string" && typeof record.action === "string" && typeof record.detail === "string"
  );
}

/**
 * Write the state, atomically.
 *
 * Temp file and rename, because the process doing the writing is the one
 * restarting a service — a half-written state file after an ill-timed exit
 * would be read as "no probation" and lose the rollback plan for a build that
 * is at that moment crash-looping.
 */
export function writeDeployState(path: string, state: DeployState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** Remember that a commit failed, most recent first, without duplicates. */
export function rememberFailure(state: DeployState, commit: string): DeployState {
  const failedCommits = [commit, ...state.failedCommits.filter((c) => c !== commit)].slice(
    0,
    MAX_REMEMBERED_FAILURES,
  );
  return { ...state, failedCommits };
}
