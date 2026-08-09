import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  /** Which store this code was written into. Printed so it can be checked. */
  readonly databasePath: string;
}

/**
 * Refuse to issue a code into a database that did not already exist.
 *
 * **The sharpest edge on this command, and it is silent without this check.**
 * The running service gets `SYL_DB_PATH` from its launchd plist, as an absolute
 * path. An interactive shell has no such variable, so `loadConfig` falls back
 * to `.syl/syl.db` — *relative to the working directory*. Run from anywhere
 * that is not where the service's store lives, this would create a new empty
 * database, migrate it, and print a perfectly valid code for a database
 * nothing is serving.
 *
 * The symptom would be "that pairing code was not accepted", forever, with the
 * command reporting success every time. So a store this command had to create
 * is treated as proof that it is pointed at the wrong one.
 *
 * @throws {Error} naming the path it resolved and how to correct it.
 */

/**
 * The store the RUNNING SERVICE uses, read from its installed launchd plist.
 *
 * `assertExistingStore` below asks "does a database exist at this path?" That
 * is the wrong question, and it let a real failure through: the repo-local
 * `.syl/syl.db` exists from development runs, so the check passed while the
 * service was reading `~/.syl/syl.db`. The command printed a valid-looking
 * pairing code into a store nothing serves — and the symptom on the phone is
 * "code not accepted", forever, with the command reporting success.
 *
 * The right question is "is this the database the SERVICE is using?", and the
 * plist is the only authority on that. It is written by `npm run launchd
 * --install` and read by launchd itself, so it cannot disagree with reality
 * the way an environment variable in somebody's shell can.
 *
 * Returns `undefined` when nothing is installed, in which case the caller
 * falls back to configuration — correct for a developer running the service by
 * hand.
 */
export function storeOfInstalledService(home?: string): string | undefined {
  const base = home ?? process.env["HOME"];
  if (base === undefined) return undefined;
  const plist = join(base, "Library", "LaunchAgents", "com.jmm.syl.core.plist");
  if (!existsSync(plist)) return undefined;
  // Deliberately a regex over the XML rather than a plist parser: this is one
  // string from a file we generated ourselves, and taking a dependency (or
  // shelling out to `plutil`, which is macOS-only) to read it would cost more
  // than it is worth.
  const xml = readFileSync(plist, "utf8");
  const match = /<key>SYL_DB_PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  return match?.[1];
}

export function assertExistingStore(databasePath: string, home?: string): void {
  if (existsSync(databasePath)) return;
  throw new Error(
    `There is no Syl database at ${resolve(databasePath)}.\n\n` +
      `A pairing code has to be written into the store the running service is\n` +
      `using, and this command would have created a new empty one instead —\n` +
      `which would print a code that can never work.\n\n` +
      `The service takes its path from SYL_DB_PATH in its launchd plist. Set the\n` +
      `same value here:\n\n` +
      `  SYL_DB_PATH=${join(home ?? "~", ".syl", "syl.db")} npm run pair\n\n` +
      `To read what the service is actually using:\n\n` +
      `  launchctl print gui/$(id -u)/com.jmm.syl | grep SYL_DB_PATH`,
  );
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
export function issueBriefing(
  db: SylDatabase,
  config: SylConfig,
  // Passed in rather than read from `config`, because the store the SERVICE
  // uses is authoritative and configuration is not — see
  // `storeOfInstalledService`. Printing the wrong path here would be worse
  // than printing none: it is the line an operator checks when a code is
  // refused.
  databasePath: string = config.databasePath,
): PairingBriefing {
  const keys = new ApiKeyService({ db: db.handle });
  const issued: PairingCode = keys.issuePairingCode();
  const live = keys.list().filter((key) => key.revokedAt === null).length;
  return {
    code: issued.code,
    expiresAt: issued.expiresAt,
    baseURL: tailnetBaseURL(config.certStatusPath),
    pairedDevices: live,
    databasePath: resolve(databasePath),
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
    // Named on every run, not only on failure. It is the one field that can be
    // quietly wrong, and a value you have seen every time is a value you notice
    // changing.
    `  Store          ${briefing.databasePath}`,
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
  // The installed service's path WINS over configuration. A shell has no
  // SYL_DB_PATH, so `loadConfig` falls back to a CWD-relative default that is
  // very likely the wrong store — see `storeOfInstalledService`.
  const installed = storeOfInstalledService();
  // Before `openDatabase`, which would otherwise create the wrong store and
  // then succeed at everything else. See `assertExistingStore`.
  const databasePath = installed ?? config.databasePath;
  assertExistingStore(databasePath, process.env["HOME"]);
  const db = openDatabase({ path: databasePath });
  try {
    const briefing = issueBriefing(db, config, databasePath);
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
