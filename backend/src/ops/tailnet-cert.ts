import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { HealthProbe } from "../routes/health.js";

/**
 * The tailnet certificate, seen from inside the service.
 *
 * `scripts/syl-cert-renew.sh` does the renewing; this reads the status file it
 * leaves behind and turns it into a health check. The split is deliberate: the
 * renewal has to work when the service is down (that is half of why it is a
 * separate launchd job), and the service has to be able to say the certificate
 * is in trouble without shelling out to `openssl` on every health request.
 *
 * The failure this is really guarding against is not the certificate expiring —
 * that is 90 days away and the renewal job handles it. It is **the renewal job
 * silently stopping**: unloaded during some other piece of surgery, or failing
 * every night against a tailnet that was renamed. From the outside those look
 * identical to everything being fine, right up until the morning the phone
 * cannot connect. So staleness of the status file is itself a fault, and it is
 * the check most likely to earn its keep.
 */

/** What the renewal script writes. Every field is re-validated on read. */
export interface CertStatus {
  readonly checkedAt: string;
  readonly hostname: string;
  readonly certPath: string;
  readonly ok: boolean;
  readonly renewed: boolean;
  /** `null` when the certificate could not be read at all. */
  readonly daysRemaining: number | null;
  readonly error: string | null;
}

/** Where the status file lives when nothing says otherwise. */
export function defaultCertStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["SYL_CERT_STATUS"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const home = env["HOME"]?.trim();
  return join(home !== undefined && home !== "" ? home : ".", ".syl", "cert-status.json");
}

/** Read and validate the status file. `null` when it is absent or unreadable. */
export function readCertStatus(path: string): CertStatus | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  // Safe assertion: guarded above, and every field below is type-tested.
  const value = parsed as Record<string, unknown>;
  if (typeof value["checkedAt"] !== "string") return null;
  const days = value["daysRemaining"];
  return {
    checkedAt: value["checkedAt"],
    hostname: typeof value["hostname"] === "string" ? value["hostname"] : "",
    certPath: typeof value["certPath"] === "string" ? value["certPath"] : "",
    ok: value["ok"] === true,
    renewed: value["renewed"] === true,
    daysRemaining: typeof days === "number" && Number.isFinite(days) ? days : null,
    error: typeof value["error"] === "string" ? value["error"] : null,
  };
}

/** Below this many days remaining, `/health` starts saying so. */
export const CERT_WARN_DAYS = 21;

/**
 * How old a status file may be before its age is itself the finding.
 *
 * The renewal job runs daily and also at load. Three days without one means it
 * has not run three times in a row, which is a stopped job rather than a slow
 * one.
 */
export const CERT_STALE_MS = 3 * 24 * 60 * 60_000;

export type CertHealth = { readonly status: "ok" | "degraded" | "down"; readonly detail: string };

/** Judge a status file. Pure, so every branch below is a test. */
export function judgeCertStatus(status: CertStatus | null, now: number): CertHealth {
  if (status === null) {
    return {
      status: "degraded",
      detail:
        "the tailnet certificate renewal has never reported. Load com.jmm.syl.cert, " +
        "or run scripts/syl-cert-renew.sh by hand.",
    };
  }

  const checkedAt = Date.parse(status.checkedAt);
  if (Number.isNaN(checkedAt)) {
    return { status: "degraded", detail: `the certificate status file has an unreadable timestamp.` };
  }

  const age = now - checkedAt;
  if (age > CERT_STALE_MS) {
    const days = Math.floor(age / 86_400_000);
    return {
      status: "degraded",
      detail:
        `the certificate renewal last reported ${String(days)} days ago. It is a daily job; ` +
        `it has stopped running, which is how a 90-day certificate becomes a surprise.`,
    };
  }

  if (!status.ok) {
    return {
      status: "degraded",
      detail: `the last renewal failed: ${status.error ?? "no reason recorded"}.`,
    };
  }

  const days = status.daysRemaining;
  if (days === null) {
    return { status: "degraded", detail: "the certificate's expiry could not be read." };
  }
  if (days <= 0) {
    return {
      status: "down",
      detail: `the tailnet certificate for ${status.hostname} has EXPIRED. The phone cannot connect.`,
    };
  }
  if (days < CERT_WARN_DAYS) {
    return {
      status: "degraded",
      detail: `the tailnet certificate expires in ${String(days)} days and renewal has not taken.`,
    };
  }
  return { status: "ok", detail: `${status.hostname} valid for ${String(days)} more days` };
}

/**
 * The health probe.
 *
 * Read per request, not captured at boot. The certificate is renewed by another
 * process while this one is running, so a value cached at startup would be
 * wrong for the entire life of the service — which for a service that never
 * restarts is forever.
 */
export function tailnetCertProbe(options: {
  readonly path: string;
  readonly now?: () => number;
}): HealthProbe {
  const now = options.now ?? Date.now;
  return {
    name: "tailnet-cert",
    run: () => {
      const judged = judgeCertStatus(readCertStatus(options.path), now());
      return { status: judged.status, detail: judged.detail };
    },
  };
}
