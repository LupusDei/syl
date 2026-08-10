import type { QuietHoursSetting } from "../config.js";
import { isWithinQuietHours } from "../harness/schedule.js";
import { isRunningCommit } from "./build-info.js";

/**
 * Whether a commit may replace Syl's running code.
 *
 * ## The gate is the whole design
 *
 * "If `origin/main` moved, build and restart" is the obvious auto-deploy and it
 * is the wrong one. It would let a 2am commit with red CI take the Commander's
 * assistant down while he sleeps, and the first symptom would be a 07:00 agenda
 * that never arrives. So the question asked here is never "has HEAD moved" — it
 * is **"have this commit's checks passed"**, asked of GitHub, with every answer
 * other than an unambiguous yes meaning stay where we are.
 *
 * ## Treat it as a safety boundary, not a convenience
 *
 * The Commander's stated direction is that Syl may eventually be able to update
 * herself. She is not being given that now and nothing here builds toward it —
 * there is deliberately no path by which the service can deploy itself. What
 * this module does is make the eventual version survivable: **everything that
 * deploys goes through `decideDeploy`, and no option turns the check
 * requirement off.** `deploy-gate.test.ts` asserts that over every combination
 * of every option, so a bypass added later fails the suite rather than shipping.
 *
 * ## Failing closed
 *
 * Every ambiguous answer means "do not deploy":
 *
 *   - the API is unreachable, rate-limited or returns junk → `unknown`;
 *   - a conclusion string we have never seen → a failure;
 *   - a commit with no check runs at all → `none`, never green. Absence of
 *     evidence is not evidence of passing, and merge commits produce exactly
 *     that shape.
 *
 * The two errors are not symmetrical. Waiting costs a few hours of staleness,
 * which `/health` now makes visible. Guessing costs the 07:00 agenda.
 */

/** One check run, reduced to the three fields any of this depends on. */
export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  /** GitHub's own id. Monotonic, so the largest is the most recent. */
  readonly id: number;
}

/**
 * Conclusions that do not block a deploy.
 *
 * `skipped` and `neutral` are here because path-filtered workflows report that
 * way: the iOS job legitimately does not run for a backend-only commit, and
 * treating that as a failure would deadlock every deploy this repository ever
 * makes.
 */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/**
 * Read `gh api repos/{owner}/{repo}/commits/{sha}/check-runs`.
 *
 * Throws rather than returning `[]` on anything that is not a check-runs
 * response. An empty list and an unreadable answer must never collapse into the
 * same value: one means "nothing ran", the other means "we do not know", and
 * only one of those is safe to reason about.
 */
export function parseCheckRuns(body: unknown): readonly CheckRun[] {
  if (typeof body !== "object" || body === null || !("check_runs" in body)) {
    throw new Error(
      `Not a check-runs response: no \`check_runs\` array. Got ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const runs = (body as { check_runs: unknown }).check_runs;
  if (!Array.isArray(runs)) throw new Error("`check_runs` is not an array.");

  return runs.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`check_runs[${String(index)}] is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    const { name, status, conclusion, id } = record;
    if (typeof name !== "string" || typeof status !== "string") {
      throw new Error(`check_runs[${String(index)}] has no usable name/status.`);
    }
    return {
      name,
      status,
      conclusion: typeof conclusion === "string" ? conclusion : null,
      id: typeof id === "number" ? id : index,
    };
  });
}

/**
 * `LupusDei/syl` out of whatever `git remote get-url origin` printed.
 *
 * Both forms are in play on this machine — the checkout uses SSH, and anything
 * cloned by a tool tends to use HTTPS — and the API path needs the slug, not
 * the URL. Returns `null` rather than guessing: the alternative is a `gh` call
 * against a repository that does not exist, whose 404 is indistinguishable from
 * "this commit has no checks", which is the one confusion that must not happen.
 */
export function parseRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const ssh = /^git@[^:]+:([^/]+\/[^/]+)$/.exec(trimmed);
  if (ssh?.[1] !== undefined) return ssh[1];
  const https = /^(?:https?|ssh):\/\/[^/]+\/([^/]+\/[^/]+)$/.exec(trimmed);
  if (https?.[1] !== undefined) return https[1];
  return null;
}

export type ChecksVerdict =
  | { readonly state: "green"; readonly detail: string }
  | { readonly state: "pending"; readonly detail: string }
  | { readonly state: "failed"; readonly detail: string }
  /** A required check produced no run at all, and everything else has finished. */
  | { readonly state: "missing"; readonly detail: string }
  /** No check runs whatsoever. Proves nothing, so it is not a pass. */
  | { readonly state: "none"; readonly detail: string }
  /** GitHub could not be asked. Never a pass. */
  | { readonly state: "unknown"; readonly detail: string };

export interface JudgeOptions {
  /**
   * Checks that must exist and pass. `verify` is `ci.yml`'s job, which runs on
   * every push to `main` with no path filter, so a commit without it has not
   * been tested at all.
   */
  readonly required: readonly string[];
}

/**
 * The current state of each named check, latest run wins.
 *
 * Re-running a workflow creates new check runs alongside the old ones, so
 * "every run must be green" would mean a commit fixed by a re-run could never
 * go green. Grouping by name and taking the highest id is what the GitHub UI
 * effectively shows. It has one known imprecision: two different workflows with
 * the same job name share a slot, and the older of the two is hidden. The
 * required check (`verify`) is unique, which is where the actual gate is.
 */
function latestByName(runs: readonly CheckRun[]): Map<string, CheckRun> {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const existing = latest.get(run.name);
    if (existing === undefined || run.id > existing.id) latest.set(run.name, run);
  }
  return latest;
}

/**
 * Green, or the reason it is not.
 *
 * Order matters and is deliberate: a failure is decisive even while other
 * checks are still running, because a red check does not go green by waiting;
 * and `pending` outranks `missing`, because seconds after a push the required
 * check may simply not have been created yet, and "missing" would be both wrong
 * and alarming.
 */
export function judgeChecks(runs: readonly CheckRun[], options: JudgeOptions): ChecksVerdict {
  if (runs.length === 0) {
    return {
      state: "none",
      detail: "no check runs for this commit. Nothing has been proved about it.",
    };
  }

  const latest = [...latestByName(runs).values()];

  const failed = latest.filter(
    (run) => run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion ?? ""),
  );
  if (failed.length > 0) {
    return {
      state: "failed",
      detail: failed.map((run) => `${run.name}=${run.conclusion ?? "no conclusion"}`).join(", "),
    };
  }

  const running = latest.filter((run) => run.status !== "completed");
  if (running.length > 0) {
    return {
      state: "pending",
      detail: running.map((run) => `${run.name}=${run.status}`).join(", "),
    };
  }

  const names = new Set(latest.map((run) => run.name));
  const missing = options.required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    return {
      state: "missing",
      detail: `required check(s) never ran: ${missing.join(", ")}`,
    };
  }

  return { state: "green", detail: `${String(latest.length)} check(s) passed` };
}

/**
 * A freshly deployed build being watched.
 *
 * The deploy's own soak window catches a build that dies in the first ninety
 * seconds. This catches the one that dies five minutes later, after the deploy
 * has exited and `KeepAlive` has begun restarting it into the same crash. The
 * marker survives in a state file so the next run of the update job can act on
 * it — the deploy process itself is long gone.
 */
export interface Probation {
  readonly commit: string;
  readonly previousCommit: string;
  readonly expiresAt: string;
}

export interface GateInputs {
  /** The commit `origin/main` points at, or `null` if it could not be read. */
  readonly target: string | null;
  /** The commit `/health` says is answering, or `null` if she cannot say. */
  readonly running: string | null;
  readonly healthy: boolean;
  readonly turnsInFlight: number | null;
  readonly checks: ChecksVerdict;
  readonly now: Date;
  /** Commits a deploy has already failed on. Never retried unattended. */
  readonly failedCommits: readonly string[];
  readonly probation: Probation | null;
}

export interface GateOptions {
  /**
   * Decline to deploy inside the quiet window. True for the unattended job:
   * the failure being guarded against is "something restarted her while he was
   * asleep", and waiting until morning costs nothing but staleness. False for a
   * human at a terminal, who is by definition awake.
   *
   * **This is not a CI bypass.** Nothing here can be set to skip the checks.
   */
  readonly respectQuietHours?: boolean;
  readonly quietHours?: QuietHoursSetting;
  /** Retry a commit a deploy has already failed on. For a human, not the job. */
  readonly allowPreviouslyFailed?: boolean;
}

export type GateReason =
  | "up-to-date"
  | "unknown-target"
  | "checks-pending"
  | "checks-failed"
  | "checks-missing"
  | "checks-none"
  | "checks-unknown"
  | "previously-failed"
  | "turn-in-flight"
  | "quiet-hours";

export type GateDecision =
  | { readonly action: "deploy"; readonly commit: string }
  | { readonly action: "rollback"; readonly to: string; readonly from: string; readonly detail: string }
  | { readonly action: "wait"; readonly reason: GateReason; readonly detail: string };

const CHECK_REASONS: Readonly<Record<Exclude<ChecksVerdict["state"], "green">, GateReason>> = {
  pending: "checks-pending",
  failed: "checks-failed",
  missing: "checks-missing",
  none: "checks-none",
  unknown: "checks-unknown",
};

/** Is this probation still watching the build that is actually running? */
function probationApplies(probation: Probation, running: string | null, now: Date): boolean {
  if (Date.parse(probation.expiresAt) <= now.getTime()) return false;
  return isRunningCommit({ commit: running, builtAt: "", dirty: false }, probation.commit);
}

/**
 * What the update job should do right now.
 *
 * Pure. Every input is a value someone else went and fetched, which is what
 * makes the whole decision testable without a network, a launchd job or a
 * running service — and what keeps the interesting logic out of a shell script
 * nobody can exercise.
 */
export function decideDeploy(inputs: GateInputs, options: GateOptions): GateDecision {
  // First, before anything else, and deliberately not subject to quiet hours:
  // a build that was deployed minutes ago and has stopped answering. She is
  // down. That is the emergency this whole mechanism exists to survive.
  if (inputs.probation !== null && !inputs.healthy) {
    if (probationApplies(inputs.probation, inputs.running, inputs.now)) {
      return {
        action: "rollback",
        to: inputs.probation.previousCommit,
        from: inputs.probation.commit,
        detail: `${inputs.probation.commit.slice(0, 7)} was deployed recently and is not answering`,
      };
    }
  }

  if (inputs.target === null) {
    return { action: "wait", reason: "unknown-target", detail: "origin/main does not resolve" };
  }

  if (inputs.healthy && isRunningCommit({ commit: inputs.running, builtAt: "", dirty: false }, inputs.target)) {
    return { action: "wait", reason: "up-to-date", detail: `already running ${inputs.target.slice(0, 7)}` };
  }

  if (inputs.checks.state !== "green") {
    return {
      action: "wait",
      reason: CHECK_REASONS[inputs.checks.state],
      detail: inputs.checks.detail,
    };
  }

  if (options.allowPreviouslyFailed !== true && inputs.failedCommits.includes(inputs.target)) {
    return {
      action: "wait",
      reason: "previously-failed",
      detail:
        `${inputs.target.slice(0, 7)} has already failed to deploy once and was rolled back. ` +
        `Retrying it unattended would restart her every run, all night.`,
    };
  }

  if (options.respectQuietHours === true && options.quietHours !== undefined) {
    const { quiet, tz } = options.quietHours;
    if (isWithinQuietHours(inputs.now, quiet, tz)) {
      return {
        action: "wait",
        reason: "quiet-hours",
        detail: `inside ${quiet.start}-${quiet.end} ${tz}. An unattended restart waits for morning.`,
      };
    }
  }

  if (inputs.turnsInFlight !== null && inputs.turnsInFlight > 0) {
    return {
      action: "wait",
      reason: "turn-in-flight",
      detail: `${String(inputs.turnsInFlight)} turn(s) running. Restarting now would cut her off mid-sentence.`,
    };
  }

  return { action: "deploy", commit: inputs.target };
}

export interface ProbationCheck {
  readonly healthy: boolean;
  readonly running: string | null;
  readonly now: Date;
}

/**
 * Whether a probation has done its job and can be forgotten.
 *
 * Two ways: the window closed with the build still healthy, or the build is no
 * longer the one running — somebody deployed over it by hand, and there is
 * nothing left for this marker to undo.
 */
export function shouldClearProbation(probation: Probation | null, check: ProbationCheck): boolean {
  if (probation === null) return false;
  if (!isRunningCommit({ commit: check.running, builtAt: "", dirty: false }, probation.commit)) return true;
  return check.healthy && Date.parse(probation.expiresAt) <= check.now.getTime();
}
