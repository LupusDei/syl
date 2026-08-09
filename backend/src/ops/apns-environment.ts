import type { PushEnvironment } from "@syl/shared";

import type { NodeEnv } from "../config.js";
import type { HealthProbe } from "../routes/health.js";

/**
 * Which Apple this deployment is talking to, asserted rather than assumed.
 *
 * A TestFlight or App Store build always produces **production** device tokens.
 * An Xcode-installed build always produces **sandbox** ones. Send a production
 * token to `api.sandbox.push.apple.com` — or the reverse — and Apple answers
 * `BadDeviceToken`. There is no other symptom: no crash, no warning, no
 * delivery-status API to consult. The reminder simply does not arrive, and
 * because `BadDeviceToken` is (correctly) classified as a dead token, the
 * device is unregistered and every *subsequent* reminder does not arrive
 * either. One mistyped build channel silently ends push, permanently.
 *
 * Routing is already per token — `ApnsClient` picks the host from the token's
 * own environment — so the code cannot get this wrong on its own. What can go
 * wrong is the *label*: a build whose entitlement and whose registration
 * disagree, or a deployment that has never been told which channel it is
 * serving. Neither is detectable after the fact, so both are checked here, at
 * boot, where the answer is still cheap.
 *
 * Adjutant pinned its entitlement to `development` while shipping through
 * TestFlight and its push works only because something else compensates. Do not
 * inherit that.
 */

/** The two answers, and the only two. */
export const PUSH_ENVIRONMENTS: readonly PushEnvironment[] = ["sandbox", "production"];

/** Names the variable, once, so a message and a check cannot drift apart. */
export const PUSH_ENVIRONMENT_VAR = "SYL_APNS_ENVIRONMENT";

/** The escape hatch for deliberately pointing a production service at sandbox. */
export const ALLOW_SANDBOX_VAR = "SYL_APNS_ALLOW_SANDBOX";

/** Whether a string is one of the two environments. */
export function isPushEnvironment(value: string): value is PushEnvironment {
  return PUSH_ENVIRONMENTS.some((candidate) => candidate === value);
}

export interface PushEnvironmentAssertion {
  /** The environment this deployment expects its device tokens to be in. */
  readonly environment: PushEnvironment;
  /** Whether that came from the environment rather than from `NODE_ENV`. */
  readonly declared: boolean;
  /** Everything that must stop the service from starting. */
  readonly problems: readonly string[];
  /** Everything that must be said loudly but is not fatal. */
  readonly warnings: readonly string[];
}

export interface PushEnvironmentInput {
  /** `SYL_APNS_ENVIRONMENT`, already trimmed. `null` when unset. */
  readonly declared: string | null;
  readonly nodeEnv: NodeEnv;
  /** Whether all four `SYL_APNS_*` credentials are present. */
  readonly pushConfigured: boolean;
  /** `SYL_APNS_ALLOW_SANDBOX`, for the deliberate case. */
  readonly allowSandbox?: boolean;
  /** Active push targets, by environment. Empty on a machine with no phone. */
  readonly registered?: readonly { readonly deviceId: string; readonly environment: PushEnvironment }[];
}

/**
 * Decide what this deployment expects, and what is wrong with that.
 *
 * A pure function of four facts, so every branch below is a test rather than a
 * thing that runs for the first time in front of the Commander.
 *
 * The rules, and why each one is a refusal rather than a warning:
 *
 * - **Push configured, production, and nothing declared** → refuse. Defaulting
 *   silently is exactly how a deployment ends up serving the wrong Apple. The
 *   fix is one line in a plist and the cost of not having it is total.
 * - **Declared, but not one of the two** → refuse. A typo here would otherwise
 *   fall through to a default and look like it worked.
 * - **Production service declaring sandbox** → refuse unless
 *   `SYL_APNS_ALLOW_SANDBOX` says it is on purpose. This is the TestFlight
 *   trap in its exact shape.
 * - **A registered token disagreeing with the declaration** → warn, do not
 *   refuse. Routing is per token, so that device still works; what it means is
 *   that a build from the other channel is installed somewhere, and the
 *   Commander should know before he wonders why one phone is quiet.
 */
export function assessPushEnvironment(input: PushEnvironmentInput): PushEnvironmentAssertion {
  const problems: string[] = [];
  const warnings: string[] = [];

  const fallback: PushEnvironment = input.nodeEnv === "production" ? "production" : "sandbox";

  if (input.declared !== null && !isPushEnvironment(input.declared)) {
    problems.push(
      `${PUSH_ENVIRONMENT_VAR} must be "production" or "sandbox", got "${input.declared}". ` +
        `TestFlight and App Store builds produce production tokens; Xcode builds produce sandbox ones.`,
    );
  }

  const environment: PushEnvironment =
    input.declared !== null && isPushEnvironment(input.declared) ? input.declared : fallback;
  const declared = input.declared !== null && isPushEnvironment(input.declared);

  if (input.pushConfigured && !declared && input.nodeEnv === "production") {
    problems.push(
      `${PUSH_ENVIRONMENT_VAR} is not set, and APNs is configured on a production service. ` +
        `Set it to "production" for a TestFlight or App Store build, or "sandbox" for a build ` +
        `installed from Xcode. A wrong guess produces BadDeviceToken on every send, unregisters ` +
        `the device, and has no other symptom.`,
    );
  }

  if (
    input.pushConfigured &&
    environment === "sandbox" &&
    input.nodeEnv === "production" &&
    input.allowSandbox !== true
  ) {
    problems.push(
      `${PUSH_ENVIRONMENT_VAR} is "sandbox" on a production service. The app the Commander ` +
        `installs comes through TestFlight, which produces production tokens. If this is ` +
        `deliberate — an Xcode build on the desk — set ${ALLOW_SANDBOX_VAR}=1 and say so out loud.`,
    );
  }

  for (const device of input.registered ?? []) {
    if (device.environment === environment) continue;
    warnings.push(
      `device ${device.deviceId} registered a ${device.environment} token while this service ` +
        `expects ${environment}. Its pushes are still routed to ${device.environment} — the ` +
        `environment is a property of the token — but a build from the other channel is ` +
        `installed somewhere, and only one of the two will keep working.`,
    );
  }

  return { environment, declared, problems, warnings };
}

/** Thrown when the APNs environment cannot be trusted. */
export class PushEnvironmentError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "Syl will not start: the APNs environment is not asserted.",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "PushEnvironmentError";
    this.problems = problems;
  }
}

/**
 * Refuse to start on an unasserted environment.
 *
 * @throws {PushEnvironmentError} when anything in `problems` is set.
 */
export function assertPushEnvironment(assessment: PushEnvironmentAssertion): PushEnvironmentAssertion {
  if (assessment.problems.length > 0) throw new PushEnvironmentError(assessment.problems);
  return assessment;
}

/** The lines to print about push, once the assertion has passed. */
export function describePushEnvironment(
  assessment: PushEnvironmentAssertion,
  options: { readonly pushConfigured: boolean },
): readonly string[] {
  if (!options.pushConfigured) {
    return [
      `[syl] APNs is not configured; push targets ${assessment.environment} when it is. ` +
        `Reminders accumulate in the outbox.`,
    ];
  }
  const source = assessment.declared ? PUSH_ENVIRONMENT_VAR : "NODE_ENV";
  return [
    `[syl] APNs environment ${assessment.environment} (from ${source})`,
    ...assessment.warnings.map((warning) => `[syl] WARNING: ${warning}`),
  ];
}

/**
 * The health check for push routing.
 *
 * Re-evaluated per request rather than captured at boot: a device registered an
 * hour after the service started is exactly the one most likely to be from the
 * wrong channel, and a probe that only knew what was true at boot would never
 * see it.
 */
export function pushEnvironmentProbe(options: {
  readonly environment: PushEnvironment;
  readonly pushConfigured: boolean;
  readonly targets: () => readonly { readonly deviceId: string; readonly environment: PushEnvironment }[];
}): HealthProbe {
  return {
    name: "apns-environment",
    run: () => {
      if (!options.pushConfigured) {
        return { status: "degraded", detail: "APNs is not configured on this machine." };
      }
      const mismatched = options.targets().filter((target) => target.environment !== options.environment);
      if (mismatched.length === 0) {
        return { status: "ok", detail: options.environment };
      }
      return {
        status: "degraded",
        detail:
          `${String(mismatched.length)} device(s) registered a token from the other APNs ` +
          `environment; this service expects ${options.environment}.`,
      };
    },
  };
}
