import { fileURLToPath } from "node:url";

import { loadConfig, type SylConfig } from "../../config.js";
import { openDatabase, type SylDatabase } from "../../services/database.js";
import { ApiKeyService, type PairingCode } from "../../services/api-key-service.js";
import { readCertStatus } from "../tailnet-cert.js";

/**
 * `npm run pair` — the command that puts a phone on the tailnet.
 *
 * ## Why this exists as a separate process
 *
 * The service runs under launchd and prints a pairing code exactly once, at
 * startup, and only while nothing is paired. That covers the first device on a
 * freshly-installed machine and nothing else: a reinstall from TestFlight onto
 * a restored phone, a second device, a revoked token, a Keychain that did not
 * survive — every one of those needs a code from a service that has already
 * decided not to print one, and there is no way to ask it for another without
 * restarting it.
 *
 * So the code is issued into the store rather than into a process's memory,
 * and this command writes one there. It does not talk to the running service,
 * does not need it to be up, and cannot be reached over the network.
 *
 * ## What it prints
 *
 * The two things a person standing with a phone needs, and nothing else: the
 * eight digits, and the URL to type into the app. The URL comes from the
 * tailnet certificate status file — the same hostname the certificate was
 * issued for, which is by construction the one the phone can reach over TLS.
 * Guessing it is the failure this project has already had once, and a printed
 * `localhost` is worse than a printed nothing.
 *
 * Usage:
 *   npm run pair                 issue a code, print it and the URL
 *   npm run pair -- --json       the same, for a script
 */

/** What the command worked out, before any of it is printed. */
export interface PairingBriefing {
  readonly code: string;
  readonly expiresAt: string;
  /** The base URL to type into the app, or `null` if it cannot be known. */
  readonly baseURL: string | null;
  /** How many devices already hold a live token. */
  readonly pairedDevices: number;
}

/** The contract's base path. Duplicated from `index.ts` to keep this leaf. */
const API_BASE_PATH = "/api/v1";

/**
 * Where the phone should point.
 *
 * `null` rather than a guess. A base URL is the one field the Commander cannot
 * check by looking at it — `https://something.ts.net` and
 * `https://somethingelse.ts.net` are equally plausible — so an invented one
 * would be typed in, fail, and look exactly like a pairing problem.
 */
export function tailnetBaseURL(certStatusPath: string): string | null {
  const status = readCertStatus(certStatusPath);
  if (status === null || status.hostname === "") return null;
  return `https://${status.hostname}${API_BASE_PATH}`;
}

/** Issue a code against an already-open store, and gather what to say about it. */
export function issueBriefing(db: SylDatabase, config: SylConfig): PairingBriefing {
  const keys = new ApiKeyService({ db: db.handle });
  const issued: PairingCode = keys.issuePairingCode();
  const live = keys.list().filter((key) => key.revokedAt === null).length;
  return {
    code: issued.code,
    expiresAt: issued.expiresAt,
    baseURL: tailnetBaseURL(config.certStatusPath),
    pairedDevices: live,
  };
}

/** The lines to print. Returned rather than printed, so a test can read them. */
export function describePairing(briefing: PairingBriefing): readonly string[] {
  const lines = [
    "",
    `  Pairing code   ${briefing.code}`,
    `  Expires        ${briefing.expiresAt}`,
  ];

  lines.push(
    briefing.baseURL === null
      ? "  Server URL     unknown — no tailnet certificate status file yet.\n" +
          "                 Run scripts/syl-cert-renew.sh, or type the host by hand\n" +
          `                 as https://<your-mac>.ts.net${API_BASE_PATH}.`
      : `  Server URL     ${briefing.baseURL}`,
  );

  lines.push(
    "",
    "  On the phone: open Syl, enter the server URL and the code above.",
    "  The code is good once, for ten minutes, and issuing another one",
    "  invalidates this. The app keeps the token it gets back; you never",
    "  type that.",
  );

  if (briefing.pairedDevices > 0) {
    lines.push(
      "",
      `  ${String(briefing.pairedDevices)} device(s) already hold a live token. Pairing another does not`,
      "  revoke them.",
    );
  }

  lines.push("");
  return lines;
}

/** Open the store, issue a code, say what to do with it. */
export function main(argv: readonly string[] = []): number {
  const config = loadConfig();
  const db = openDatabase({ path: config.databasePath });
  try {
    const briefing = issueBriefing(db, config);
    if (argv.includes("--json")) {
      console.log(JSON.stringify(briefing, null, 2));
    } else {
      for (const line of describePairing(briefing)) console.log(line);
    }
    return 0;
  } finally {
    // Always. The service is very likely holding this file too, and a CLI that
    // exits without closing leaves a WAL lock behind for the busy timeout to
    // trip over on the next write.
    db.close();
  }
}

/** Run only when executed directly, so importing this in a test issues nothing. */
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(78);
  }
}
