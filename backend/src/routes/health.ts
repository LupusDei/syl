import { Router } from "express";

import type { SylConfig } from "../config.js";

/**
 * Liveness for the Syl service.
 *
 * Deliberately small. The API contract will settle the exact shape; until it
 * does, this reports only what the process can answer without touching a
 * store, a socket or a subprocess — plus the one fact that is genuinely ours.
 *
 * That fact is `credentialSource`. Syl's strongest constraint is that it runs
 * on subscription rails and never the metered API, and a stray
 * `ANTHROPIC_API_KEY` in the environment is the one thing that quietly breaks
 * it. A health check that can only say "ok" would report perfect health while
 * the Commander's billing was being rerouted.
 */
export interface HealthBody {
  /** Liveness. The process answered, so it is up. */
  readonly status: "ok";
  /** Service version, from `backend/package.json`. */
  readonly version: string;
  /**
   * Seconds since this router was created, i.e. since the service booted.
   * Measured on a monotonic clock, so an NTP correction cannot make it jump
   * backwards or report a negative uptime.
   */
  readonly uptimeSeconds: number;
  /**
   * Which environment variable would supply Anthropic credentials, in the
   * CLI's own `apiKeySource` vocabulary. `"none"` means subscription rails.
   * Never the credential value — only the variable's name.
   */
  readonly credentialSource: string;
  /** `credentialSource === "none"`. False means billing is at risk. */
  readonly subscriptionRails: boolean;
}

/**
 * Build the health router.
 *
 * @param config  the resolved service configuration
 * @param now     monotonic millisecond clock. Injected so uptime is assertable
 *                rather than "roughly"; defaults to `performance.now` rather
 *                than `Date.now` because wall-clock time can step backwards.
 */
export function createHealthRouter(
  config: SylConfig,
  now: () => number = () => performance.now(),
): Router {
  const startedAt = now();
  const router = Router();

  router.get("/health", (_request, response) => {
    const body: HealthBody = {
      status: "ok",
      version: config.version,
      // Milliseconds are noise in a health check and make the value awkward to
      // eyeball; three decimals keeps it precise enough to be useful.
      uptimeSeconds: Math.round(now() - startedAt) / 1000,
      credentialSource: config.credentialSource,
      subscriptionRails: config.subscriptionRails,
    };

    response.status(200).json(body);
  });

  return router;
}
