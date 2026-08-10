import { Router } from "express";

import type { BuildInfo, HealthCheck, HealthStatus } from "@syl/shared";

import type { SylConfig } from "../config.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import { sendOk } from "./envelope.js";

/**
 * Liveness and dependency status, in the contract's shape.
 *
 * `status` is the worst of the checks rather than a separate judgement, so a
 * green top line can never sit above a red dependency. `degraded` is a real
 * and useful answer: Syl with a failing APNs channel is still worth talking
 * to, and reporting `down` would send a monitor into a restart loop over
 * something a restart cannot fix.
 *
 * The check that is genuinely ours is `subscription-rails`. Syl's strongest
 * constraint is that she runs on subscription payment rails and never the
 * metered API, and a stray `ANTHROPIC_API_KEY` in the environment silently
 * outranks the claude.ai login. A health endpoint that could only say "ok"
 * would report perfect health while the Commander's billing was rerouted —
 * this is how that hazard becomes visible before a statement makes it visible.
 */

/** One dependency this service can be asked about. */
export interface HealthProbe {
  readonly name: string;
  /**
   * Answer for this dependency. Must not throw and must not block — a health
   * endpoint that hangs is worse than one that reports `down`, because a
   * monitor cannot tell it apart from a network failure.
   */
  run(): { readonly status: HealthCheck["status"]; readonly detail?: string | null };
}

const SEVERITY: Readonly<Record<HealthCheck["status"], number>> = {
  ok: 0,
  degraded: 1,
  down: 2,
};

/** The worst status among the checks, or `ok` when there are none. */
export function worstStatus(
  checks: readonly HealthCheck[],
): HealthCheck["status"] {
  let worst: HealthCheck["status"] = "ok";
  for (const check of checks) {
    if (SEVERITY[check.status] > SEVERITY[worst]) worst = check.status;
  }
  return worst;
}

/**
 * The billing check, built from configuration alone.
 *
 * `degraded` rather than `down`: the service works, and the harness strips
 * both credential variables before spawning `claude`. What is at risk is
 * anything that reaches the CLI another way.
 */
export function subscriptionRailsProbe(config: SylConfig): HealthProbe {
  return {
    name: "subscription-rails",
    run: () =>
      config.subscriptionRails
        ? { status: "ok", detail: "claude.ai subscription" }
        : {
            status: "degraded",
            detail:
              `${config.credentialSource} is set. The harness strips it before spawning claude, ` +
              `but anything reaching the CLI another way bills the metered API.`,
          },
  };
}

/**
 * The store, checked by actually querying it.
 *
 * A probe that only asks whether a handle exists reports `ok` against a
 * database whose file has been deleted out from under it — SQLite keeps
 * serving from the open descriptor until it needs a page it does not have.
 */
export function databaseProbe(db: Database): HealthProbe {
  return {
    name: "database",
    run: () => {
      try {
        db.prepare("SELECT count(*) AS n FROM schema_migrations").get();
        return { status: "ok", detail: null };
      } catch (error) {
        return { status: "down", detail: error instanceof Error ? error.message : "unreadable" };
      }
    },
  };
}

export interface HealthRouterOptions {
  readonly config: SylConfig;
  /** Extra dependencies to report. The billing check is always included. */
  readonly probes?: readonly HealthProbe[];
  readonly clock?: Clock;
  /**
   * What this process was built from, read once at boot from the stamp inside
   * `dist/`. `null` — the default — is what running from source looks like, and
   * is a real answer rather than a missing one.
   *
   * Deliberately a value and not a function. It cannot change while the process
   * lives, and anything that recomputed it per request would be asking the
   * working tree rather than the artifact, which is the exact mistake this
   * field exists to make impossible.
   */
  readonly build?: BuildInfo | null;
  /**
   * How many conversations have a turn running or queued, asked at request
   * time. Omit for a service with no conversation surface.
   */
  readonly turnsInFlight?: () => number;
}

/**
 * Build the health router.
 *
 * `startedAt` is captured when the router is built, which is once, during
 * boot — so it is the service's start time rather than the first request's.
 */
export function createHealthRouter(options: HealthRouterOptions): Router {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const probes: readonly HealthProbe[] = [subscriptionRailsProbe(config), ...(options.probes ?? [])];
  const startedAt = instant(clock());
  const build = options.build ?? null;
  const turnsInFlight = options.turnsInFlight;

  const router = Router();

  router.get("/health", (_request, response) => {
    const checks: HealthCheck[] = probes.map((probe) => {
      const result = probe.run();
      return { name: probe.name, status: result.status, detail: result.detail ?? null };
    });

    const body: HealthStatus = {
      status: worstStatus(checks),
      version: config.version,
      startedAt,
      now: instant(clock()),
      checks,
      // Always present, explicitly null when unknown. A field that disappears
      // when there is nothing to say is indistinguishable from an old build
      // that never had the field at all — which is the one question this
      // endpoint must be able to answer.
      build,
      ...(turnsInFlight === undefined ? {} : { turnsInFlight: turnsInFlight() }),
    };

    // Always 200. `status` inside the body is the answer; a non-200 here would
    // be indistinguishable from the proxy in front of Syl being unhappy, and
    // "degraded" is information a monitor should read, not a failure it should
    // retry through.
    sendOk(response, body);
  });

  return router;
}
