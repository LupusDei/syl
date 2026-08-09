/**
 * The retry policy.
 *
 * Three rules, and each of them is in the contract rather than invented here:
 *
 * 1. **Only `retryable` failures are retried.** The spec is explicit that auth
 *    failures halt — "retrying an auth failure fifty times is the worst
 *    possible response to a key having shadowed the subscription login".
 * 2. **`retryAfterMs` is a floor, not a suggestion.** When the server names
 *    one it wins, even over the local cap: it knows something we do not.
 * 3. **Jitter, always.** One admin tab is not a thundering herd, but the same
 *    policy is meant to serve the mobile client, and there the herd is real.
 *
 * Retries here apply to **reads only**. Every write in the contract requires
 * an `Idempotency-Key`, and a retry loop that does not carry one turns a
 * timeout into a duplicate. The admin client is read-only for exactly that
 * reason; a write surface must set the key before it may reuse this.
 */

import { isAdminApiError } from "./errors";

export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retrying. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of the delay to spread either side of it. `0` is deterministic. */
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  jitterRatio: 0.25,
};

/**
 * How long to wait after `attempt` (1-based) has failed.
 *
 * `random` is injected so the policy is a pure function under test — a
 * backoff whose tests have to tolerate randomness is a backoff whose bugs
 * hide in the tolerance.
 */
export function backoffDelayMs(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs: number | null,
  random: () => number,
): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
  // random() === 0.5 lands exactly on the exponential value, which is what
  // makes the tests readable.
  const spread = exponential * policy.jitterRatio * (random() * 2 - 1);
  const jittered = Math.max(0, Math.round(exponential + spread));

  const floor = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
  return Math.max(jittered, floor);
}

export type Sleep = (ms: number) => Promise<void>;

export interface RetryOptions {
  readonly policy?: RetryPolicy | undefined;
  /** Injectable so tests do not spend real seconds. */
  readonly sleep?: Sleep | undefined;
  readonly random?: (() => number) | undefined;
}

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run `operation`, retrying only what the taxonomy says is worth retrying.
 *
 * Anything that is not an `AdminApiError` — an `AbortError` from a cancelled
 * view, a programming mistake — propagates on the first throw. Guessing that
 * an unknown throw is transient is how a bug becomes an infinite loop.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (cause: unknown) {
      if (!isAdminApiError(cause) || !cause.retryable || attempt >= policy.maxAttempts) throw cause;
      await sleep(backoffDelayMs(policy, attempt, cause.retryAfterMs, random));
    }
  }
}
