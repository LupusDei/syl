import type { BuildInfo, HealthStatus } from "@syl/shared";

import { isRunningCommit } from "./build-info.js";

/**
 * Replacing Syl's running code, and putting it back if that goes wrong.
 *
 * ## What this is for
 *
 * Syl is a supervised LaunchAgent on the Commander's machine. She wakes him at
 * 07:00 and carries reminders he relies on. This module replaces her running
 * process **unattended, while he is asleep**, which sets the standard: a deploy
 * that leaves her down is worse than no deploy at all. Every branch below is
 * written for the case where nobody is watching and nobody can be asked.
 *
 * ## Why the logic is here and not in the script
 *
 * The rollback is the part that has to work and the part that is hardest to
 * reach — you cannot exercise it without breaking a live service. So the whole
 * decision sequence takes its git, npm, launchctl, health-probe and clock as
 * injected effects, and `src/ops/cli/deploy.ts` is a thin shell that supplies
 * the real ones. Same split as `syl-watchdog.sh` over `ops/launchd.ts`.
 *
 * ## The three ideas that make it safe
 *
 * 1. **The health gate asks "is she answering AS THE NEW COMMIT", not "is she
 *    answering".** Those differ in the exact case that matters: if the new
 *    build fails to load, launchd's `KeepAlive` can leave the previous process
 *    answering perfectly, and a deploy that only checked for a 200 would call
 *    that success. The build stamp in `dist/build-info.json` is what makes the
 *    stronger question askable at all.
 * 2. **A soak window after she comes up.** A process that starts and dies
 *    thirty seconds later looks identical to a healthy one for those thirty
 *    seconds, and `KeepAlive` will restart it into the same broken build
 *    forever. The soak watches `startedAt`: if it moves, she restarted herself,
 *    and that is a crash loop rather than a deploy.
 * 3. **The previous `dist/` is saved before the new one is built**, and the
 *    build stamp lives inside it — so restoring it restores the provenance too,
 *    with nothing to keep in sync.
 *
 * ## What it deliberately does NOT do
 *
 * It does not roll back the database. Migrations run forward when the new build
 * starts and there is no down path, so a rollback restores the code and leaves
 * the schema ahead of it. The outcome reports the migrations involved so the
 * situation is visible rather than silent — `syl-dep1.7`, with an acceptance
 * test that stays red until it is fixed.
 */

/** What a `/health` probe found. Never throws; unreachable is a value. */
export interface HealthSnapshot {
  readonly reachable: boolean;
  readonly status: HealthStatus["status"] | null;
  /** What the answering process was built from. `null` when it cannot say. */
  readonly build: BuildInfo | null;
  /** The answering process's own start time. Moves when she restarts. */
  readonly startedAt: string | null;
  readonly turnsInFlight: number | null;
}

/** One line in the deploy's own record. Nobody is watching this run live. */
export interface DeployEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly detail?: string;
}

/**
 * Everything the deploy does to the world.
 *
 * Every one of these is a real, irreversible act on the Commander's machine,
 * which is exactly why they are all behind this interface: the test suite
 * substitutes a simulation and exercises the rollback paths that could
 * otherwise only be reached by breaking a live service.
 */
export interface DeployEffects {
  /** `git fetch --prune origin`. */
  fetch(): Promise<void>;
  /** The SHA a ref resolves to, or `null` when it does not resolve. */
  resolve(ref: string): Promise<string | null>;
  /** Uncommitted or untracked changes present? */
  isDirty(): Promise<boolean>;
  /** The checked-out branch, or `null` on a detached HEAD. */
  currentBranch(): Promise<string | null>;
  /** Is `ancestor` reachable from `descendant`? */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** Move the checkout to this commit. */
  checkout(commit: string): Promise<void>;
  /** Migration files added between two commits. */
  migrationsBetween(from: string, to: string): Promise<readonly string[]>;
  /** `npm run verify`. Rejects with the output on failure. */
  verify(): Promise<void>;
  /** `npm run build`. Rejects with the output on failure. */
  build(): Promise<void>;
  /** Copy `dist/` aside. `false` when there was no `dist/` to save. */
  saveDist(): Promise<boolean>;
  /** Put the saved `dist/` back. */
  restoreDist(): Promise<void>;
  /** `launchctl kickstart -k`. */
  restart(): Promise<void>;
  /** `GET /health`. Must not throw. */
  probe(): Promise<HealthSnapshot>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(event: DeployEvent): void;
}

/** Why a deploy declined to happen. None of these leave her restarted. */
export type RefusalReason =
  | "dirty-tree"
  | "wrong-branch"
  | "unknown-commit"
  | "not-fast-forward"
  | "verify-failed"
  | "build-failed"
  | "no-rollback-target"
  | "turn-in-flight"
  | "effect-failed";

/** Why a deploy was undone. */
export type RollbackTrigger = "never-healthy" | "crash-loop";

export type DeployOutcome =
  | { readonly kind: "up-to-date"; readonly commit: string }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly detail: string }
  | {
      readonly kind: "deployed";
      readonly commit: string;
      readonly previousCommit: string | null;
      readonly migrations: readonly string[];
    }
  | {
      readonly kind: "rolled-back";
      readonly commit: string;
      readonly previousCommit: string;
      readonly failure: RollbackTrigger;
      readonly migrations: readonly string[];
      /**
       * Whether the schema was put back with the code.
       *
       * Always `false` today. Reported rather than assumed, because "the code
       * is back" and "the system is back" are different claims once a migration
       * has run, and only one of them is true. See `syl-dep1.7`.
       */
      readonly schemaRestored: boolean;
    }
  | {
      readonly kind: "rollback-failed";
      readonly commit: string;
      readonly previousCommit: string;
      readonly failure: RollbackTrigger;
      readonly detail: string;
    };

export interface DeployOptions {
  /** The exact commit to deploy. Chosen by the gate, never by this module. */
  readonly commit: string;
  /** The only branch a deploy may run on. */
  readonly branch?: string;
  /** How long the new build has to answer as itself. */
  readonly healthDeadlineMs?: number;
  /** How long it must keep answering, without restarting, to count. */
  readonly settleMs?: number;
  /** How long the restored build has to come back. */
  readonly rollbackDeadlineMs?: number;
  /** How long to wait for a turn in flight to finish before giving up. */
  readonly idleWaitMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Proceed even though there is no previous `dist/` to fall back to.
   *
   * For the first install on a machine, and only for a human who has decided
   * to take that risk. An unattended run must never set this.
   */
  readonly allowWithoutRollback?: boolean;
}

const DEFAULTS = {
  branch: "main",
  /**
   * Two minutes. She binds a port, opens SQLite, applies migrations and loads
   * an embedding model at start; on the Intel iMac that is tens of seconds, so
   * a deadline near it would roll back a build that was merely slow. Rolling
   * back a working deploy is a cheap mistake, but a needless one.
   */
  healthDeadlineMs: 120_000,
  /**
   * Ninety seconds of continuous health before a deploy counts. Long enough to
   * catch the crash-on-first-real-work case, short enough that a deploy is not
   * an event. It does not catch a build that dies after this window — see the
   * probation check in `deploy-gate.ts`, which is what covers that.
   */
  settleMs: 90_000,
  rollbackDeadlineMs: 120_000,
  /** A turn can legitimately take minutes; a research brief takes longer. */
  idleWaitMs: 300_000,
  pollIntervalMs: 3_000,
} as const;

/** Nothing answered, or what answered was not a health body. */
export const UNREACHABLE: HealthSnapshot = {
  reachable: false,
  status: null,
  build: null,
  startedAt: null,
  turnsInFlight: null,
};

/**
 * Turn a `/health` response body into a snapshot.
 *
 * Anything unrecognisable is `UNREACHABLE` rather than a partial snapshot: the
 * only thing worse than not knowing whether the new build is up is *believing*
 * it is on the strength of a body we could not read.
 */
export function snapshotFromHealth(body: unknown): HealthSnapshot {
  if (typeof body !== "object" || body === null) return UNREACHABLE;
  const envelope = body as Record<string, unknown>;
  const data = envelope.success === true ? envelope.data : envelope;
  if (typeof data !== "object" || data === null) return UNREACHABLE;

  const health = data as Record<string, unknown>;
  const status = health.status;
  if (status !== "ok" && status !== "degraded" && status !== "down") return UNREACHABLE;

  const build = health.build;
  const stamp =
    typeof build === "object" && build !== null
      ? (build as Record<string, unknown>)
      : null;

  return {
    reachable: true,
    status,
    build:
      stamp === null || typeof stamp.builtAt !== "string"
        ? null
        : {
            commit: typeof stamp.commit === "string" ? stamp.commit : null,
            builtAt: stamp.builtAt,
            dirty: stamp.dirty === true,
            branch: typeof stamp.branch === "string" ? stamp.branch : null,
          },
    startedAt: typeof health.startedAt === "string" ? health.startedAt : null,
    turnsInFlight: typeof health.turnsInFlight === "number" ? health.turnsInFlight : null,
  };
}

/** Is this snapshot a healthy service running the commit we asked for? */
export function isHealthyAs(snapshot: HealthSnapshot, commit: string): boolean {
  if (!snapshot.reachable) return false;
  // `degraded` is fine and often correct — a failing APNs channel does not mean
  // the deploy failed. `down` is not.
  if (snapshot.status === "down") return false;
  return isRunningCommit(snapshot.build, commit);
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Pull, verify, build, restart, and put it all back if she does not come up.
 *
 * Returns an outcome for every expected failure and throws for none of them: an
 * unattended caller running from launchd has no useful `catch` to write, and an
 * exception there would be a stack trace in a log file nobody reads instead of
 * a decision.
 */
export async function deploy(effects: DeployEffects, options: DeployOptions): Promise<DeployOutcome> {
  const settings = { ...DEFAULTS, ...options };
  const target = options.commit;

  /** State that the failure paths need and the happy path fills in. */
  let previousCommit: string | null = null;
  let movedCheckout = false;
  let savedDist = false;
  let restarted = false;
  let migrations: readonly string[] = [];

  const log = (level: DeployEvent["level"], event: string, detail?: string): void => {
    effects.log(detail === undefined ? { level, event } : { level, event, detail });
  };

  /** Poll until `predicate` holds, or the deadline passes. */
  const until = async (
    deadlineMs: number,
    predicate: (snapshot: HealthSnapshot) => boolean,
  ): Promise<boolean> => {
    const deadline = effects.now() + deadlineMs;
    for (;;) {
      if (predicate(await effects.probe())) return true;
      if (effects.now() >= deadline) return false;
      await effects.sleep(settings.pollIntervalMs);
    }
  };

  /**
   * Undo everything, and confirm she is answering again afterwards.
   *
   * "Restored the files" is not the claim worth making. The claim worth making
   * is "she answers, as the previous build" — which is the same standard the
   * deploy itself is held to, and the only one that means the Commander still
   * has an assistant in the morning.
   */
  const rollBack = async (failure: RollbackTrigger, why: string): Promise<DeployOutcome> => {
    // Safe assertion: no rollback is attempted before `previousCommit` is read,
    // and every path that sets `restarted` or `savedDist` has read it.
    const previous = previousCommit as string;
    log("error", "deploy.rolling_back", `${why}; restoring ${previous.slice(0, 7)}`);

    try {
      if (savedDist) await effects.restoreDist();
      if (movedCheckout) await effects.checkout(previous);
    } catch (error) {
      log("error", "deploy.rollback_failed", message(error));
      return {
        kind: "rollback-failed",
        commit: target,
        previousCommit: previous,
        failure,
        detail:
          `${why}. THE ROLLBACK ALSO FAILED: ${message(error)}. ` +
          `Syl may be down. Restore by hand: git -C <repo> checkout ${previous}, ` +
          `npm run build, launchctl kickstart -k gui/$(id -u)/com.jmm.syl.core`,
      };
    }

    try {
      await effects.restart();
    } catch (error) {
      log("error", "deploy.rollback_failed", message(error));
      return {
        kind: "rollback-failed",
        commit: target,
        previousCommit: previous,
        failure,
        detail: `${why}. The previous build was restored but could not be started: ${message(error)}`,
      };
    }

    if (!(await until(settings.rollbackDeadlineMs, (snapshot) => isHealthyAs(snapshot, previous)))) {
      log("error", "deploy.rollback_failed", "the restored build does not answer either");
      return {
        kind: "rollback-failed",
        commit: target,
        previousCommit: previous,
        failure,
        detail:
          `${why}. The previous build was restored and does NOT answer either. ` +
          `Both builds are broken; nothing automatic can fix this.`,
      };
    }

    log("error", "deploy.rolled_back", `back on ${previous.slice(0, 7)} and answering`);
    return {
      kind: "rolled-back",
      commit: target,
      previousCommit: previous,
      failure,
      migrations,
      // The code is back. The schema is not, and saying otherwise would be the
      // comfortable lie. `syl-dep1.7`.
      schemaRestored: false,
    };
  };

  /** Undo a half-done deploy that never got as far as restarting her. */
  const abandon = async (reason: RefusalReason, detail: string): Promise<DeployOutcome> => {
    try {
      if (savedDist) await effects.restoreDist();
      if (movedCheckout && previousCommit !== null) await effects.checkout(previousCommit);
    } catch (error) {
      log("error", "deploy.cleanup_failed", message(error));
    }
    log("warn", "deploy.refused", `${reason}: ${detail}`);
    return { kind: "refused", reason, detail };
  };

  try {
    log("info", "deploy.begin", `target ${target.slice(0, 7)}`);

    await effects.fetch();

    const resolved = await effects.resolve(target);
    if (resolved === null) {
      return await abandon("unknown-commit", `${target} does not resolve to a commit in this checkout`);
    }

    previousCommit = await effects.resolve("HEAD");
    if (previousCommit === null) {
      return await abandon("unknown-commit", "HEAD does not resolve; this is not a usable checkout");
    }

    const before = await effects.probe();
    if (isHealthyAs(before, target)) {
      log("info", "deploy.up_to_date", `already running ${target.slice(0, 7)}`);
      return { kind: "up-to-date", commit: target };
    }

    if (await effects.isDirty()) {
      return await abandon(
        "dirty-tree",
        "the working tree has uncommitted changes. A deploy would move the checkout out from under them.",
      );
    }

    const branch = await effects.currentBranch();
    if (branch !== settings.branch) {
      return await abandon(
        "wrong-branch",
        `on ${branch ?? "a detached HEAD"}, and a deploy only runs on ${settings.branch}`,
      );
    }

    if (previousCommit !== target && !(await effects.isAncestor(previousCommit, target))) {
      return await abandon(
        "not-fast-forward",
        `${target.slice(0, 7)} is not a descendant of ${previousCommit.slice(0, 7)}. ` +
          `Moving the checkout backwards is a rollback, and it is not this command's job.`,
      );
    }

    migrations = previousCommit === target ? [] : await effects.migrationsBetween(previousCommit, target);
    if (migrations.length > 0) {
      // Said out loud before anything moves, because it changes what a rollback
      // can promise: the code goes back and the schema does not.
      log("warn", "deploy.migrations", `${String(migrations.length)} new migration(s): ${migrations.join(", ")}`);
    }

    if (previousCommit !== target) {
      await effects.checkout(target);
      movedCheckout = true;
      log("info", "deploy.checked_out", target.slice(0, 7));
    }

    try {
      await effects.verify();
    } catch (error) {
      return await abandon("verify-failed", message(error));
    }
    log("info", "deploy.verified");

    // Save BEFORE building. The build writes over `dist/` in place, so after it
    // starts there is no previous build left to go back to — and a build that
    // fails half way leaves a directory that is neither.
    const hadDist = await effects.saveDist();
    savedDist = hadDist;
    if (!hadDist && options.allowWithoutRollback !== true) {
      return await abandon(
        "no-rollback-target",
        "there is no existing dist/ to fall back to. Pass --allow-without-rollback if this is a first install.",
      );
    }

    try {
      await effects.build();
    } catch (error) {
      return await abandon("build-failed", message(error));
    }
    log("info", "deploy.built", target.slice(0, 7));

    // Not mid-sentence. The gate checked this too, but verify and build take
    // minutes and she may have started a turn in the meantime.
    const idle = await until(settings.idleWaitMs, (snapshot) => {
      const turns = snapshot.turnsInFlight;
      if (turns === null || turns === 0) return true;
      log("info", "deploy.waiting_for_idle", `${String(turns)} turn(s) in flight`);
      return false;
    });
    if (!idle) {
      // Give the new build back rather than restart her mid-turn. Leaving it in
      // place would be the worst of both: the next crash would activate an
      // unverified build through KeepAlive, and nothing would have said so.
      return await abandon(
        "turn-in-flight",
        `a turn was still running after ${String(settings.idleWaitMs)}ms. The new build has been put aside; the next run will retry.`,
      );
    }

    await effects.restart();
    restarted = true;
    log("info", "deploy.restarted");

    if (!(await until(settings.healthDeadlineMs, (snapshot) => isHealthyAs(snapshot, target)))) {
      return await rollBack(
        "never-healthy",
        `${target.slice(0, 7)} did not answer as itself within ${String(settings.healthDeadlineMs)}ms`,
      );
    }
    log("info", "deploy.healthy", target.slice(0, 7));

    // The soak. She is up; the question is whether she stays up. A process that
    // dies a minute in looks exactly like a healthy one until it does.
    const firstStart = (await effects.probe()).startedAt;
    const soakUntil = effects.now() + settings.settleMs;
    while (effects.now() < soakUntil) {
      await effects.sleep(settings.pollIntervalMs);
      const snapshot = await effects.probe();
      if (snapshot.reachable && snapshot.startedAt !== firstStart) {
        log("warn", "deploy.restarted_itself", `startedAt moved to ${snapshot.startedAt ?? "unknown"}`);
        return await rollBack("crash-loop", "the new build restarted itself during the soak window");
      }
      if (!isHealthyAs(snapshot, target)) {
        log("warn", "deploy.unhealthy_during_soak");
        return await rollBack("crash-loop", "the new build stopped answering during the soak window");
      }
    }

    log("info", "deploy.done", `${target.slice(0, 7)} is running and settled`);
    return { kind: "deployed", commit: target, previousCommit, migrations };
  } catch (error) {
    // An effect threw where none was expected to — git is missing, the disk is
    // full, launchctl is not there. If she has already been restarted this is a
    // rollback situation; if not, it is a refusal.
    log("error", "deploy.effect_failed", message(error));
    if (restarted && previousCommit !== null) {
      return await rollBack("never-healthy", `the deploy failed part-way: ${message(error)}`);
    }
    return { kind: "refused", reason: "effect-failed", detail: message(error) };
  }
}
