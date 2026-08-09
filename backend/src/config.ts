import { createRequire } from "node:module";

import type { PushEnvironment } from "@syl/shared";

import type { QuietHours } from "./harness/schedule.js";
import { defaultLogDirectory } from "./ops/logging.js";
import { defaultCertStatusPath } from "./ops/tailnet-cert.js";

/**
 * Service configuration, read from the environment once at boot.
 *
 * `loadConfig` is a pure function of an environment object rather than a reader
 * of `process.env`. That is what makes every validation branch testable without
 * mutating globals, and it keeps the "where does this value come from" answer
 * to a single call site in `main`.
 *
 * **Everything the environment supplies is checked here, at boot, and nowhere
 * else.** A value that is only parsed at first use is a value whose typo is
 * discovered by the failure it causes — and for the quiet-hours window that
 * first use is inside the reminder-delivery handler, five minutes after a
 * clean-looking start, where a throw is recorded as a job failure and five of
 * those open a circuit breaker that never closes. One typo in
 * `SYL_QUIET_START` ended all reminder delivery, permanently, with nothing but
 * a stack trace on stderr to say why (`syl-085`). A misconfigured service must
 * refuse to start.
 */

/** The environments the service knows how to be. */
export type NodeEnv = "development" | "test" | "production";

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];

/**
 * Loopback, not `0.0.0.0`. Syl holds the Commander's to-dos and drives a
 * pre-authorised Claude session; binding every interface by default would put
 * that on the local network before there is any auth in front of it. Exposure
 * should be a deliberate `HOST=0.0.0.0`, or better, a tunnel.
 */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Syl's own port. **Not 4201** — that is Adjutant's backend, and it is running
 * on this machine.
 *
 * This was 4201, on the reasoning that `.mcp.json` already pointed there. That
 * reading was wrong and cost a real failure: the `.mcp.json` in this repo
 * configures the *Adjutant MCP server* Syl's agents talk to for messaging. It
 * has never described Syl's own service.
 *
 * Installed as a LaunchAgent with that default, Syl would have failed to bind
 * on every boot, forever — `EADDRINUSE` from a neighbour that was there first.
 * Not a degraded assistant: an assistant that never starts, and therefore every
 * delivery guarantee in the system silently void.
 *
 * The damage was not hypothetical and not limited to Syl. Running the service
 * by hand on 4201 bound `*:4201` **alongside** Adjutant's `127.0.0.1:4201` —
 * the two do not collide, they coexist, and MCP calls then land on whichever
 * socket the kernel picks. Syl serves no `/mcp` route, so Adjutant's MCP
 * connection simply died. A port collision that fails loudly costs a boot; one
 * that half-succeeds takes down the neighbour, which is the worse outcome and
 * the one that actually happened.
 *
 * Found by running the launchd entrypoint on the target machine rather than in
 * a test. Nothing in the suite could have caught it: the integration tests bind
 * a random high port, correctly, and are therefore blind to it by construction.
 *
 * 8888 is deliberately outside the 42xx block entirely, chosen by the Commander
 * after the above. Everything else here lives in that block — Adjutant 4200 and
 * 4201, the contract mock 4210, the Syl admin dev server 4211 — so picking a
 * free number *inside* it only buys the next collision. Distance is the point.
 */
export const DEFAULT_PORT = 8888;

/**
 * The operational store, under the repo's own dot-directory.
 *
 * `.syl/` is already where session ids live and is already gitignored, so a
 * developer cannot accidentally commit the Commander's to-dos. A production
 * deployment sets `SYL_DB_PATH` to somewhere that gets backed up.
 */
export const DEFAULT_DATABASE_PATH = ".syl/syl.db";

/**
 * Environment variables that supply Anthropic credentials, in the order the
 * CLI resolves them. `session.ts` deletes both before spawning `claude`.
 */
export const CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

// The version belongs to the package manifest, not to a constant that drifts
// from it. `createRequire` reads it synchronously at import with no import
// assertion and no build step. If the manifest is missing the service is
// broken anyway, so there is deliberately nothing to catch here.
const requireFromHere = createRequire(import.meta.url);
// Safe assertion: this is our own manifest, one directory up, and the shape is
// re-checked below rather than trusted.
const manifest = requireFromHere("../package.json") as { readonly version?: unknown };

/** The running service's version, as declared by `backend/package.json`. */
export const SERVICE_VERSION: string =
  typeof manifest.version === "string" ? manifest.version : "0.0.0";

/**
 * A quiet window and the zone it is expressed in.
 *
 * Structurally identical to `QuietHoursPolicy` in `services/outbox.ts`, and
 * declared here rather than imported from there because this module is the one
 * that decides whether a policy is usable at all. Config may not depend on the
 * store it configures.
 */
export interface QuietHoursSetting {
  readonly quiet: QuietHours;
  /** An IANA zone name. Never a fixed UTC offset. */
  readonly tz: string;
}

/** The environment variables that describe the quiet window. */
export const QUIET_HOURS_ENV_VARS = ["SYL_QUIET_START", "SYL_QUIET_END", "SYL_TZ"] as const;

/** 24-hour `HH:MM`. The same grammar `harness/schedule.ts` parses. */
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface SylConfig {
  /** Interface to bind. Loopback unless deliberately widened. */
  readonly host: string;
  /** TCP port to listen on. */
  readonly port: number;
  readonly nodeEnv: NodeEnv;
  /** Service version, reported on `/api/v1/health`. */
  readonly version: string;
  /** Where the SQLite operational store lives. */
  readonly databasePath: string;
  /**
   * Which environment variable would hand credentials to a child `claude`
   * process, in the CLI's own `apiKeySource` vocabulary. `"none"` means the
   * claude.ai subscription login is what gets used.
   *
   * Never the credential itself — only the name of the variable holding it.
   */
  readonly credentialSource: string;
  /** `credentialSource === "none"`. The billing constraint, as a boolean. */
  readonly subscriptionRails: boolean;
  /**
   * When the outbox holds a delivery back, and the zone that window is read in.
   *
   * Validated here so that everything downstream — `Outbox`, the delivery
   * handler, `deferPastQuietHours` — is handed a window it is guaranteed to be
   * able to parse.
   */
  readonly quietHours: QuietHoursSetting;
  /**
   * Which Apple this deployment expects its device tokens to come from.
   *
   * `null` means nothing was declared, which is a *refusal* in production —
   * see `ops/apns-environment.ts`. Kept as the declared value rather than a
   * resolved one so the assertion can tell "he said production" apart from
   * "we assumed production", and say which in the startup line.
   */
  readonly pushEnvironment: PushEnvironment | null;
  /** `SYL_APNS_ALLOW_SANDBOX`: a production service pointed at sandbox on purpose. */
  readonly allowSandboxPush: boolean;
  /** Where the rotated operational log lives. */
  readonly logDirectory: string;
  /** Where the certificate renewal job leaves its status. */
  readonly certStatusPath: string;
}

/** Thrown when the environment cannot produce a usable configuration. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "Syl cannot start: the environment is not a valid configuration.",
        ...problems.map((p) => `  - ${p}`),
      ].join("\n"),
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Read an environment variable, treating blank and whitespace-only as unset.
 *
 * An exported-but-empty variable is how CI systems and `.env` files spell
 * "I did not set this". Failing validation on it would be hostile.
 */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Name the variable that would supply Anthropic credentials, or `"none"`.
 *
 * A set `ANTHROPIC_API_KEY` silently outranks the claude.ai login and reroutes
 * billing to the metered API — the failure recorded in `adj-t64m9`. `runTurn`
 * strips both variables before spawning, so the harness itself is safe; but
 * anything that reaches `claude` another way (`npm run ping`, a developer's own
 * shell, a future subprocess someone adds) is not. Surfacing this on
 * `/api/health` is how the hazard becomes visible before a billing statement
 * makes it visible.
 */
export function resolveCredentialSource(env: NodeJS.ProcessEnv): string {
  for (const name of CREDENTIAL_ENV_VARS) {
    if (read(env, name) !== undefined) return name;
  }
  return "none";
}

/**
 * The default quiet window, and the Commander's zone.
 *
 * An IANA zone, never a fixed UTC offset. An offset is a property of an
 * instant rather than of a place, and one that reaches storage survives
 * exactly one daylight-saving boundary before moving every window by an hour.
 */
export const DEFAULT_QUIET_HOURS: QuietHoursSetting = {
  quiet: { start: "22:00", end: "08:00" },
  tz: "America/Chicago",
};

/**
 * Whether a string names a place rather than an offset.
 *
 * Two checks, because either alone lets the wrong thing through. `Intl` throws
 * on a name it does not know — but it *accepts* `"-06:00"` in some runtimes,
 * and an offset is a property of an instant rather than of a place: one that
 * reaches storage is correct until the next daylight-saving boundary and an
 * hour wrong forever after. This is the same rule `ReminderService` applies to
 * a reminder's `tz`; a value the two disagree about is a value that is valid
 * in one half of the service and invalid in the other, which is the defect
 * `syl-085` recorded.
 */
export function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return false;
  }
  return tz.includes("/") || tz === "UTC";
}

/** Everything wrong with a quiet-hours setting, in the words an operator needs. */
export function quietHoursProblems(setting: QuietHoursSetting): readonly string[] {
  const problems: string[] = [];

  for (const [name, value] of [
    ["SYL_QUIET_START", setting.quiet.start],
    ["SYL_QUIET_END", setting.quiet.end],
  ] as const) {
    if (!WALL_TIME.test(value)) {
      problems.push(`${name} must be a 24-hour HH:MM wall time (e.g. "22:00"), got "${value}".`);
    }
  }

  if (!isIanaTimeZone(setting.tz)) {
    problems.push(
      `SYL_TZ must be an IANA zone naming a place (e.g. "America/Chicago"), got "${setting.tz}". ` +
        `An offset is a property of an instant, not of a place, and drifts an hour at every ` +
        `daylight-saving boundary.`,
    );
  }

  return problems;
}

/**
 * Check a quiet-hours setting, or refuse it.
 *
 * @throws {ConfigError} if the window or the zone cannot be used.
 */
export function assertQuietHours<T extends QuietHoursSetting>(setting: T): T {
  const problems = quietHoursProblems(setting);
  if (problems.length > 0) throw new ConfigError(problems);
  return setting;
}

/** The quiet window an environment describes, unchecked. */
export function readQuietHours(env: NodeJS.ProcessEnv): QuietHoursSetting {
  return {
    quiet: {
      start: read(env, "SYL_QUIET_START") ?? DEFAULT_QUIET_HOURS.quiet.start,
      end: read(env, "SYL_QUIET_END") ?? DEFAULT_QUIET_HOURS.quiet.end,
    },
    tz: read(env, "SYL_TZ") ?? DEFAULT_QUIET_HOURS.tz,
  };
}

/**
 * The quiet window an environment describes, checked.
 *
 * Re-exported from `services/outbox.ts` as `quietHoursFromEnv`, which is where
 * every caller reaches it. It lives here because the environment is this
 * module's business and because a store must not be the thing that decides
 * whether its own configuration is usable.
 *
 * @throws {ConfigError} if the window or the zone cannot be used.
 */
export function loadQuietHours(env: NodeJS.ProcessEnv): QuietHoursSetting {
  return assertQuietHours(readQuietHours(env));
}

/** Parse a port, or push a human-readable problem and fall back to the default. */
function parsePort(raw: string | undefined, problems: string[]): number {
  if (raw === undefined) return DEFAULT_PORT;

  // `Number` rather than `parseInt`: `parseInt("8080abc")` happily returns
  // 8080, which is exactly the silent misconfiguration this is here to catch.
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(`PORT must be a whole number, got "${raw}".`);
    return DEFAULT_PORT;
  }
  if (value < 1 || value > 65535) {
    problems.push(`PORT must be between 1 and 65535, got ${value}.`);
    return DEFAULT_PORT;
  }
  return value;
}

/** Parse NODE_ENV against the known set. */
function parseNodeEnv(raw: string | undefined, problems: string[]): NodeEnv {
  if (raw === undefined) return "development";

  const match = NODE_ENVS.find((candidate) => candidate === raw);
  if (match === undefined) {
    problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(", ")}, got "${raw}".`);
    return "development";
  }
  return match;
}

/**
 * Build the service configuration from an environment.
 *
 * Every problem is collected and reported in one throw. Fixing misconfiguration
 * one restart at a time is a bad way to spend a morning.
 *
 * @throws {ConfigError} if any value is present but unusable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SylConfig {
  const problems: string[] = [];

  // SYL_PORT, not PORT. `PORT` is far too generic a name to trust: it is set
  // in this very machine's agent environment (to 4201, Adjutant's), and it
  // silently overrode the built-in default when the launchd plists were
  // generated — putting Syl straight onto her neighbour's port for the SECOND
  // time in one day. The first time cost Adjutant's MCP connection.
  //
  // Every other variable this service reads is already namespaced —
  // SYL_DB_PATH, SYL_LOG_DIR, SYL_APNS_*. `PORT` was the lone exception, and
  // the codebase did not even agree with itself: the core plist wrote `PORT`
  // while the watchdog read `SYL_PORT`, so the two halves of the same install
  // could disagree about where the service was.
  //
  // Deliberately NOT falling back to `PORT`. A fallback would preserve exactly
  // the leak this removes.
  const port = parsePort(read(env, "SYL_PORT"), problems);
  const nodeEnv = parseNodeEnv(read(env, "NODE_ENV"), problems);

  // HOST gets its own handling rather than going through `read`. An empty
  // HOST means "unset"; a HOST of "   " means someone fumbled a value, and
  // silently binding loopback instead of saying so is how a deployment ends up
  // listening somewhere nobody expected.
  const rawHost = env["HOST"];
  const trimmedHost = rawHost?.trim() ?? "";
  if (rawHost !== undefined && rawHost !== "" && trimmedHost === "") {
    problems.push("HOST was set to whitespace. Unset it, or give it a real interface.");
  }
  const host = trimmedHost === "" ? DEFAULT_HOST : trimmedHost;

  // Collected rather than thrown, so a start that is wrong about both the port
  // and the quiet window says so once instead of twice.
  const quietHours = readQuietHours(env);
  problems.push(...quietHoursProblems(quietHours));

  // Validated here and carried as the declared value. The *consequences* of a
  // wrong environment belong to `ops/apns-environment.ts`, which knows whether
  // APNs is configured at all; what belongs here is refusing a value that is
  // neither of the two words, because that would otherwise fall through to a
  // default and look exactly like it worked.
  const declaredPush = read(env, "SYL_APNS_ENVIRONMENT");
  if (declaredPush !== undefined && declaredPush !== "production" && declaredPush !== "sandbox") {
    problems.push(
      `SYL_APNS_ENVIRONMENT must be "production" or "sandbox", got "${declaredPush}". ` +
        `TestFlight builds produce production tokens; Xcode builds produce sandbox ones.`,
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const credentialSource = resolveCredentialSource(env);

  return {
    host,
    port,
    nodeEnv,
    version: SERVICE_VERSION,
    databasePath: read(env, "SYL_DB_PATH") ?? DEFAULT_DATABASE_PATH,
    credentialSource,
    subscriptionRails: credentialSource === "none",
    quietHours,
    pushEnvironment: declaredPush === "production" || declaredPush === "sandbox" ? declaredPush : null,
    allowSandboxPush: read(env, "SYL_APNS_ALLOW_SANDBOX") !== undefined,
    logDirectory: defaultLogDirectory(env),
    certStatusPath: defaultCertStatusPath(env),
  };
}
