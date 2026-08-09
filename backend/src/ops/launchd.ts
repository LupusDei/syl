import { join } from "node:path";

/**
 * The launchd jobs that make Syl a service rather than a program somebody ran.
 *
 * Rendered from code rather than checked in as three literal `.plist` files,
 * because every path in them is absolute and machine-specific — the repository
 * root, the home directory, the log directory, the port — and a checked-in
 * plist with somebody else's paths in it is a file that is wrong on every
 * machine including the one it was written on, six months later.
 *
 * ## Agent, not daemon — and this is not a preference
 *
 * The obvious reading of "start before anyone logs in" is a `LaunchDaemon` in
 * `/Library/LaunchDaemons`. It is wrong here, for a reason that is specific to
 * this system: **the `claude` CLI's subscription credentials live in the login
 * keychain.** (`security find-generic-password -s "Claude Code-credentials"` —
 * `login.keychain-db`.) That keychain is locked until the account logs in. A
 * daemon running at boot would come up perfectly, answer health checks
 * perfectly, and fail every single turn — while non-negotiable constraint 1
 * says the subscription is the *only* rail we may bill.
 *
 * So the core job is a `LaunchAgent`, and "survives a reboot with nobody
 * present" is bought with **automatic login** instead. That is a Commander
 * action and it is in the runbook, along with the FileVault consequence: with
 * FileVault on, a power cut leaves the Mac at a pre-boot unlock screen and
 * nothing this repository can do will get past it.
 *
 * ## Two jobs, not one
 *
 * `KeepAlive` restarts a process that has **died**. Nothing in launchd notices
 * one that is **wedged** — still running, still holding port 4201, answering
 * nothing. That is the 3am failure, and it is why `com.jmm.syl.watchdog` exists
 * on a `StartInterval` and probes health over the loopback like a client would.
 */

/** Anything that can appear in a plist. */
export type PlistValue =
  | string
  | number
  | boolean
  | readonly PlistValue[]
  | { readonly [key: string]: PlistValue };

/** XML-escape a text node. `&` first, or the escapes escape each other. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render one value as plist XML at the given indentation. */
function renderValue(value: PlistValue, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value ? "true" : "false"}/>`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${String(value)}</integer>`
      : `${indent}<real>${String(value)}</real>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    const items = value.map((item) => renderValue(item as PlistValue, `${indent}  `)).join("\n");
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }
  // Safe assertion: the four other branches are exhausted, so this is the
  // dictionary arm of the union.
  const entries = Object.entries(value as Record<string, PlistValue>);
  if (entries.length === 0) return `${indent}<dict/>`;
  const body = entries
    .map(([key, item]) => `${indent}  <key>${escapeXml(key)}</key>\n${renderValue(item, `${indent}  `)}`)
    .join("\n");
  return `${indent}<dict>\n${body}\n${indent}</dict>`;
}

/** A complete, `plutil`-valid plist document. */
export function toPlistXml(value: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderValue(value, ""),
    "</plist>",
    "",
  ].join("\n");
}

/** Everything a Syl launchd job needs to know about this machine. */
export interface LaunchdPaths {
  /** Absolute path to the repository checkout. */
  readonly repoRoot: string;
  /** Absolute path to the account's home directory. Daemons get no `HOME`. */
  readonly home: string;
  /** Where the rotated logs and the launchd capture files go. */
  readonly logDirectory: string;
  /** Absolute path to the `node` binary. `PATH` is not usable under launchd. */
  readonly nodeBin: string;
  /** Absolute path to the operational SQLite store. */
  readonly databasePath: string;
  /** The port the service binds and the watchdog probes. */
  readonly port: number;
  /** The tailnet hostname the certificate is issued for. */
  readonly tailnetHostname?: string;
  /** Extra environment for the core job — the four `SYL_APNS_*`, the zone. */
  readonly environment?: Readonly<Record<string, string>>;
}

/** One rendered job: its label, its filename, and its contents. */
export interface LaunchdJob {
  readonly label: string;
  /** `<label>.plist`. What it must be called in `~/Library/LaunchAgents`. */
  readonly filename: string;
  readonly plist: Readonly<Record<string, PlistValue>>;
}

export const CORE_LABEL = "com.jmm.syl.core";
export const WATCHDOG_LABEL = "com.jmm.syl.watchdog";
export const CERT_LABEL = "com.jmm.syl.cert";

/**
 * A `PATH` that works under launchd.
 *
 * launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no
 * Homebrew, no `~/.local/bin`, no nvm. This is the same lesson `claude-bin.ts`
 * already learned the hard way: the same machine resolves a binary under an
 * interactive zsh and throws `ENOENT` under launchd. Every binary these jobs
 * invoke is either absolute or on this list.
 */
export function launchdPath(home: string): string {
  return [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

/**
 * The core service.
 *
 * `KeepAlive` is unconditional rather than `{ SuccessfulExit: false }`: a
 * service that has finished is not a state Syl has. `ThrottleInterval` is 10
 * rather than launchd's default 10 by accident — it is stated so that a future
 * reader knows a crash loop backs off ten seconds and does not burn the machine.
 *
 * `ProcessType` is `Adaptive`, deliberately **not** the `Background` that
 * Adjutant's plist uses. `Background` opts a job into aggressive CPU and I/O
 * throttling, which is right for an indexer and wrong for something a phone is
 * waiting on over a tunnel.
 */
export function coreJob(paths: LaunchdPaths): LaunchdJob {
  const environment: Record<string, PlistValue> = {
    PATH: launchdPath(paths.home),
    HOME: paths.home,
    NODE_ENV: "production",
    PORT: String(paths.port),
    SYL_DB_PATH: paths.databasePath,
    SYL_LOG_DIR: paths.logDirectory,
    ...(paths.environment ?? {}),
  };

  return {
    label: CORE_LABEL,
    filename: `${CORE_LABEL}.plist`,
    plist: {
      Label: CORE_LABEL,
      ProgramArguments: ["/bin/bash", join(paths.repoRoot, "scripts", "syl-service.sh")],
      EnvironmentVariables: environment,
      WorkingDirectory: paths.repoRoot,
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      // Under launchd's default 20s, so the service's own bounded shutdown
      // always wins the race and gets to say why it is going.
      ExitTimeOut: 20,
      ProcessType: "Adaptive",
      // launchd holds these open, so they cannot be rotated by renaming — the
      // service's own rotated JSON log is the one that is bounded, and the
      // watchdog truncates these in place when they grow.
      StandardOutPath: join(paths.logDirectory, "launchd-core.log"),
      StandardErrorPath: join(paths.logDirectory, "launchd-core.log"),
    },
  };
}

/** How often the watchdog looks, in seconds. */
export const WATCHDOG_INTERVAL_SECONDS = 60;

/**
 * The wedge detector.
 *
 * Probes `/health` over the loopback exactly as a client would, because that is
 * the only question worth asking: not "is there a process" — launchd already
 * knows that — but "does it answer".
 */
export function watchdogJob(paths: LaunchdPaths): LaunchdJob {
  return {
    label: WATCHDOG_LABEL,
    filename: `${WATCHDOG_LABEL}.plist`,
    plist: {
      Label: WATCHDOG_LABEL,
      ProgramArguments: ["/bin/bash", join(paths.repoRoot, "scripts", "syl-watchdog.sh")],
      EnvironmentVariables: {
        PATH: launchdPath(paths.home),
        HOME: paths.home,
        SYL_PORT: String(paths.port),
        SYL_LOG_DIR: paths.logDirectory,
        SYL_CORE_LABEL: CORE_LABEL,
      },
      WorkingDirectory: paths.repoRoot,
      // Not at load. The core job is starting at the same moment, and a
      // watchdog that probes a service still binding its port would count a
      // failure against it on every single boot.
      RunAtLoad: false,
      StartInterval: WATCHDOG_INTERVAL_SECONDS,
      StandardOutPath: join(paths.logDirectory, "launchd-watchdog.log"),
      StandardErrorPath: join(paths.logDirectory, "launchd-watchdog.log"),
    },
  };
}

/**
 * Certificate renewal.
 *
 * Daily at 03:40, inside quiet hours, and `RunAtLoad` as well so a machine that
 * was off at 03:40 — which after a power cut is every machine — checks as soon
 * as it comes back rather than waiting for tomorrow. The renewal itself is a
 * no-op when there is nothing to do, so running it often is free.
 */
export function certJob(paths: LaunchdPaths): LaunchdJob {
  return {
    label: CERT_LABEL,
    filename: `${CERT_LABEL}.plist`,
    plist: {
      Label: CERT_LABEL,
      ProgramArguments: ["/bin/bash", join(paths.repoRoot, "scripts", "syl-cert-renew.sh")],
      EnvironmentVariables: {
        PATH: launchdPath(paths.home),
        HOME: paths.home,
        SYL_LOG_DIR: paths.logDirectory,
        SYL_CERT_DIR: join(paths.home, ".syl", "certs"),
        SYL_CERT_STATUS: join(paths.home, ".syl", "cert-status.json"),
        ...(paths.tailnetHostname === undefined ? {} : { SYL_TAILNET_HOSTNAME: paths.tailnetHostname }),
      },
      WorkingDirectory: paths.repoRoot,
      RunAtLoad: true,
      StartCalendarInterval: { Hour: 3, Minute: 40 },
      StandardOutPath: join(paths.logDirectory, "launchd-cert.log"),
      StandardErrorPath: join(paths.logDirectory, "launchd-cert.log"),
    },
  };
}

/** All three jobs, in the order they should be loaded. */
export function sylLaunchdJobs(paths: LaunchdPaths): readonly LaunchdJob[] {
  return [coreJob(paths), watchdogJob(paths), certJob(paths)];
}

/**
 * The commands that install a job, in order.
 *
 * `bootout` before `bootstrap` because `bootstrap` on an already-loaded label
 * fails with `Bootstrap failed: 5: Input/output error`, which says nothing at
 * all about the actual cause. `|| true` on the bootout, because it fails the
 * same unhelpful way when the label is *not* loaded, which is the first-install
 * case.
 */
export function installCommands(job: LaunchdJob, options: { readonly uid: number }): readonly string[] {
  const domain = `gui/${String(options.uid)}`;
  const target = `${domain}/${job.label}`;
  return [
    `launchctl bootout ${target} 2>/dev/null || true`,
    `launchctl bootstrap ${domain} ~/Library/LaunchAgents/${job.filename}`,
    `launchctl enable ${target}`,
    `launchctl print ${target} | head -20`,
  ];
}
