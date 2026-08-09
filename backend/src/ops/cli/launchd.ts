import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installCommands, sylLaunchdJobs, toPlistXml, type LaunchdPaths } from "../launchd.js";
import { defaultLogDirectory } from "../logging.js";

/**
 * `npm run launchd` — render this machine's launchd jobs.
 *
 * Every path in a Syl plist is absolute and machine-specific, so the plists are
 * generated here rather than checked in. Prints by default; `--install` writes
 * them into `~/Library/LaunchAgents` and prints the `launchctl` lines that load
 * them.
 *
 * Usage:
 *   npm run launchd                       print all three plists
 *   npm run launchd -- --install          write them, then print the commands
 *   npm run launchd -- --out <dir>        write them somewhere else
 *   npm run launchd -- --host <fqdn>      the tailnet hostname for the cert job
 */

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

const argv = process.argv.slice(2);
const repoRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", ".."));
const home = homedir();

// The four APNs values and the zone are forwarded from the current shell if it
// has them, because the alternative is a plist that boots a service which
// cannot push and says nothing about why.
const forwarded: Record<string, string> = {};
for (const name of [
  "SYL_APNS_KEY_ID",
  "SYL_APNS_TEAM_ID",
  "SYL_APNS_BUNDLE_ID",
  "SYL_APNS_PRIVATE_KEY",
  "SYL_APNS_ENVIRONMENT",
  "SYL_TZ",
  "SYL_QUIET_START",
  "SYL_QUIET_END",
]) {
  const value = process.env[name];
  if (value !== undefined && value.trim() !== "") forwarded[name] = value;
}

const paths: LaunchdPaths = {
  repoRoot,
  home,
  logDirectory: flag(argv, "logs") ?? defaultLogDirectory(),
  nodeBin: process.execPath,
  databasePath: flag(argv, "db") ?? join(home, ".syl", "syl.db"),
  port: Number(flag(argv, "port") ?? process.env["PORT"] ?? "4201"),
  ...(flag(argv, "host") === undefined ? {} : { tailnetHostname: flag(argv, "host") ?? "" }),
  environment: forwarded,
};

const jobs = sylLaunchdJobs(paths);
const outDir = flag(argv, "out") ?? join(home, "Library", "LaunchAgents");
const install = argv.includes("--install") || flag(argv, "out") !== undefined;

if (!install) {
  for (const job of jobs) {
    console.log(`# ---- ${join(outDir, job.filename)} ----`);
    console.log(toPlistXml(job.plist));
  }
  console.log("# Nothing was written. Re-run with --install to write these.");
} else {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(paths.logDirectory, { recursive: true });
  for (const job of jobs) {
    const path = join(outDir, job.filename);
    // 0600, and the mode is re-applied because `writeFileSync`'s `mode` only
    // applies when it creates the file — re-running the installer over an
    // existing plist would otherwise leave whatever permissions it already had.
    //
    // The core job's `EnvironmentVariables` contains `SYL_APNS_PRIVATE_KEY`,
    // which is the contents of the `.p8`. A plist at the default 0644 puts an
    // Apple signing key where every process running as any user on this machine
    // can read it, in a directory nobody thinks of as a secret store.
    writeFileSync(path, toPlistXml(job.plist), { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`wrote ${path}`);
  }
  console.log("");
  console.log("# Now load them:");
  for (const job of jobs) {
    for (const command of installCommands(job, { uid: userInfo().uid })) console.log(command);
  }
}

if (Object.keys(forwarded).length === 0) {
  console.error(
    "\n[syl] WARNING: no SYL_APNS_* values were in this shell, so the core job will boot\n" +
      "      with push unconfigured and reminders will accumulate in the outbox.\n" +
      "      Export them and re-run, or edit the plist.",
  );
}
