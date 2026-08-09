import { createRequire } from "node:module";

/**
 * Service configuration, read from the environment once at boot.
 *
 * `loadConfig` is a pure function of an environment object rather than a reader
 * of `process.env`. That is what makes every validation branch testable without
 * mutating globals, and it keeps the "where does this value come from" answer
 * to a single call site in `main`.
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

/** 4201 is what `.mcp.json` already points at. Do not drift from it. */
export const DEFAULT_PORT = 4201;

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

export interface SylConfig {
  /** Interface to bind. Loopback unless deliberately widened. */
  readonly host: string;
  /** TCP port to listen on. */
  readonly port: number;
  readonly nodeEnv: NodeEnv;
  /** Service version, reported on `/api/health`. */
  readonly version: string;
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

  const port = parsePort(read(env, "PORT"), problems);
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

  if (problems.length > 0) throw new ConfigError(problems);

  const credentialSource = resolveCredentialSource(env);

  return {
    host,
    port,
    nodeEnv,
    version: SERVICE_VERSION,
    credentialSource,
    subscriptionRails: credentialSource === "none",
  };
}
