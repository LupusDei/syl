import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

// Type-only. Nothing in `@syl/shared` may be imported as a *value* from the
// backend: the package's `exports` point at TypeScript source, which the
// compiled `dist/` could not load at runtime.
import type { ApiError, ErrorCode } from "@syl/shared";

/**
 * Syl's client for Syl's own API.
 *
 * ## Why she goes over HTTP to a service she is already inside
 *
 * The tempting shortcut is to hand her tools the `ReminderService` object. It
 * is in the same process, it is right there, and it would be faster. It is
 * wrong. **Validation, idempotency, quiet-hours deferral and the store's CHECK
 * constraints are enforced at the API boundary.** A second path into the same
 * data would have to re-implement every one of them, and the day it drifts is
 * the day a reminder she made behaves differently from one the phone made —
 * with no test able to notice, because both paths would be passing their own.
 *
 * One door. She queues at it like everyone else. The cost is a loopback round
 * trip on a service already on the machine, which is irrelevant against a
 * multi-second turn.
 *
 * ## Why nothing here throws
 *
 * A tool call that throws crosses the MCP boundary as a stack trace, and
 * reaches the Commander as silence — or worse, as Syl saying she set a reminder
 * because nothing told her she had not. Every outcome is a value: either data,
 * or a {@link ToolFailure} carrying a kind, the operation and **a sentence she
 * can say out loud**. "Something failed" is not an answer.
 *
 * The one exception is the constructor, and it is deliberate: a base URL that
 * is not this machine is a programming error, not a runtime outcome, and the
 * failure mode is her credential leaving the machine.
 */

/** The transport, narrowed to what this module uses. `globalThis.fetch` fits. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How a call went wrong, at the coarsest useful grain.
 *
 * Four kinds, and the split is by **what she should say and do about it**
 * rather than by where in the stack it happened:
 *
 * - `refused` — the service answered, in the contract, and said no. She knows
 *   exactly why and can repeat it.
 * - `unreachable` — nothing answered. The service may be restarting; this is
 *   the one worth trying again.
 * - `timed_out` — something answered too slowly to wait for. Distinct from
 *   `unreachable` because the write may nonetheless have landed, which is a
 *   materially different thing to tell somebody.
 * - `malformed` — something answered and it was not Syl. A proxy, a captive
 *   portal, a Tailscale error page.
 */
export type ToolFailureKind = "refused" | "unreachable" | "timed_out" | "malformed";

/** What went wrong, in a form she can turn into a sentence. */
export interface ToolFailure {
  readonly kind: ToolFailureKind;
  /** `POST /reminders`. What she was trying to do, in the API's own words. */
  readonly operation: string;
  /** The HTTP status, when there was a response at all. */
  readonly status: number | null;
  /** The contract's typed code, when the body was a contract failure. */
  readonly code: ErrorCode | null;
  /** A complete sentence. Never empty, whatever happened. */
  readonly message: string;
  /**
   * Whether trying again could plausibly work.
   *
   * Taken from the contract's own `retryable` where there is one, rather than
   * inferred from the status: the service is the authority on which of its
   * refusals are worth repeating, and a client that decided for itself would be
   * a second opinion that drifts.
   */
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | null;
}

/** What a call produced. Never an exception. */
export type ToolResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly status: number;
      /**
       * Whether the service replayed a previous identical write.
       *
       * Surfaced rather than hidden because it is the difference between "I
       * made that" and "that was already made". She should not report creating
       * something twice.
       */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly failure: ToolFailure };

export interface SylApiClientOptions {
  /** The contract base, e.g. `http://127.0.0.1:4201/api/v1`. Loopback only. */
  readonly baseUrl: string;
  /** The `agent` credential. See `services/agent-key.ts`. */
  readonly token: string;
  /** Injected for the tests that model a transport failure. */
  readonly fetch?: FetchLike;
  /** Injected so a test can hold a key still and provoke a replay. */
  readonly idempotencyKey?: () => string;
  /** How long to wait for her own service. See {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * How long to wait for a service on the same machine.
 *
 * Generous, because the cost of being wrong in each direction is asymmetric: a
 * slow write that is abandoned may still land, leaving her unsure whether she
 * made the reminder — and constraint 4 is about exactly that uncertainty. A
 * timeout here is a deadlock breaker, not a latency budget.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Every IPv6 spelling of `::1` this accepts.
 *
 * An explicit set rather than a full address normaliser, and the omission is
 * the safe direction: an exotic-but-valid spelling is refused, which costs one
 * line of configuration, while a normaliser with a bug would *accept* something
 * that is not this machine, which costs the credential. Nobody writes a base
 * URL as `0:0:0:0:0:0:0:0001`.
 */
const IPV6_LOOPBACK: ReadonlySet<string> = new Set([
  "::1",
  "0:0:0:0:0:0:0:1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
]);

/**
 * Whether a host means "this machine" and nothing else.
 *
 * Deliberately **not** shared with `connections/address-guard.ts`, which is the
 * SSRF blocklist. That module answers "may Syl open a connection to this?" for
 * hostile input and its list grows — `100.64.0.0/10` was missing once. This
 * answers a fixed question about a value in our own configuration, and the two
 * having separate reasons to change is why they have separate code. `US4` also
 * holds `connections/` to exactly one importer, and a client that carries Syl's
 * credential has no business being the second door into the quarantine.
 */
export function isLoopbackHost(host: string): boolean {
  // `new URL("http://[::1]").hostname` keeps the brackets.
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (bare === "localhost") return true;

  switch (isIP(bare)) {
    case 4:
      // The whole of 127.0.0.0/8, which is what the kernel treats as loopback.
      return bare.startsWith("127.");
    case 6: {
      const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(bare);
      if (mapped !== null) return (mapped[1] ?? "").startsWith("127.");
      return IPV6_LOOPBACK.has(bare);
    }
    default:
      // A hostname that is not `localhost`. Refused even if it would resolve to
      // 127.0.0.1 today: what a name resolves to is not a property of the
      // configuration, and this check exists to make the configuration legible.
      return false;
  }
}

/** Whether a URL points at this machine and nowhere else. */
export function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHost(url.hostname);
}

/**
 * What Syl says when her own credential stops being accepted.
 *
 * `syl-009.5.2`. **The API's own 401 is deliberately uninformative and must
 * stay that way**: `middleware/auth.ts` renders every rejection — malformed,
 * unknown, revoked, expired — as one sentence, because a caller who can tell
 * them apart has an oracle for guessing tokens. That sentence ends "Re-pair
 * this device", which is the right advice for the audience it was written for
 * and the wrong advice for this one. Left alone it reaches the Commander as
 * *Syl telling him to re-pair his phone* — sending him to fix the one thing
 * that is not broken, at the exact moment somebody has deliberately taken her
 * hands away.
 *
 * So the translation happens **here**, and here is the only place it can:
 *
 * - This client knows something the middleware refuses to guess — **which
 *   credential was presented**. It presented the agent token itself, so a 401
 *   is unambiguous about whose key stopped working, and no oracle is created
 *   because nothing was learned from the response.
 * - It never crosses the network. The message goes up the MCP pipe to a model
 *   on the same machine; the wire body the service actually sent is unchanged,
 *   and `tests/unit/auth.test.ts` still holds it to one indistinguishable form.
 *
 * The sentence says the three things a person can act on: nothing was written,
 * his phone is unaffected, and how she gets her hands back.
 */
function revokedCredential(operation: string): string {
  return (
    `Syl's own credential is no longer accepted, so ${operation} did not happen and nothing ` +
    "was written. Her key has been revoked or has expired — this says nothing about the " +
    "Commander's phone, which carries a different credential and is unaffected. She gets a " +
    "working one again when the service restarts."
  );
}

/** The failure envelope, as far as this module reads it. */
interface FailureBody {
  readonly success: false;
  readonly error: ApiError;
}

/** Whether a parsed body is the contract's failure envelope. */
function isFailureBody(body: unknown): body is FailureBody {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { success?: unknown; error?: unknown };
  if (candidate.success !== false) return false;
  const error = candidate.error;
  return typeof error === "object" && error !== null && typeof (error as ApiError).code === "string";
}

/** Whether a parsed body is the contract's success envelope, with a payload. */
function isSuccessBody(body: unknown): body is { success: true; data: unknown } {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { success?: unknown; data?: unknown };
  // `data` is checked for presence rather than truthiness: a route may
  // legitimately answer `data: null`, and `undefined` typed as `T` is the
  // failure this guard exists to prevent.
  return candidate.success === true && Object.hasOwn(candidate, "data") && candidate.data !== undefined;
}

export class SylApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #newKey: () => string;
  readonly #timeoutMs: number;
  /** For the "unreachable" message: where she actually tried. */
  readonly #origin: string;

  constructor(options: SylApiClientOptions) {
    // `new URL` throws on nonsense, which is the right outcome and the reason
    // this is not wrapped: a client built against an unparseable address can
    // never make a single successful call, so failing at construction turns a
    // silent hundred failures into one loud one.
    const url = new URL(options.baseUrl);
    if (!isLoopbackUrl(url)) {
      throw new Error(
        `Syl's own API client refuses ${url.origin}: it must be loopback. ` +
          "This client carries the agent credential, and that credential must never leave " +
          "the machine it was minted on — not even to the tailnet, which is how the service " +
          "is reachable at all and is not a boundary between the Commander's own devices.",
      );
    }
    if (options.token.trim() === "") {
      throw new Error(
        "Syl's own API client was given no token. Every call would answer 401 and she would " +
          "report a hundred identical failures instead of one missing credential.",
      );
    }

    // Trailing slash removed once, here, so every call site can write a path
    // that begins with one and no call produces `//reminders`.
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.#origin = url.host;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#newKey = options.idempotencyKey ?? randomUUID;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Read. Query values are encoded; `undefined` ones are dropped. */
  async get<T>(
    path: string,
    query: Readonly<Record<string, string | number | undefined>> = {},
  ): Promise<ToolResult<T>> {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) search.set(name, String(value));
    }
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    return this.#request<T>("GET", `${path}${suffix}`, undefined);
  }

  /** Create. Carries a fresh `Idempotency-Key`. */
  async post<T>(path: string, body?: unknown): Promise<ToolResult<T>> {
    return this.#request<T>("POST", path, body);
  }

  /** Amend. Carries a fresh `Idempotency-Key`. */
  async patch<T>(path: string, body?: unknown): Promise<ToolResult<T>> {
    return this.#request<T>("PATCH", path, body);
  }

  /**
   * Cancel. Carries a fresh `Idempotency-Key`.
   *
   * Named `del` because `delete` is a reserved word, and spelled out here so
   * nobody has to wonder whether it is a different operation.
   */
  async del<T>(path: string): Promise<ToolResult<T>> {
    return this.#request<T>("DELETE", path, undefined);
  }

  /**
   * One call, and every way it can end.
   *
   * The order of the branches is the order the failures actually occur in, and
   * each one produces a `ToolFailure` rather than falling through to a generic
   * catch — a single "request failed" bucket is exactly the outcome this module
   * exists to prevent.
   */
  async #request<T>(method: string, path: string, body: unknown): Promise<ToolResult<T>> {
    // Without the query string: this is what she will say she was doing, and
    // `POST /reminders` is a better sentence than `POST /reminders?limit=20`.
    const operation = `${method} ${path.split("?")[0] ?? path}`;
    // Every write takes one. `GET` deliberately does not — there is nothing to
    // run twice, and the ledger would grow a row per read.
    const idempotent = method !== "GET";

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          ...(idempotent ? { "Idempotency-Key": this.#newKey() } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      return { ok: false, failure: this.#transportFailure(operation, error) };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return {
        ok: false,
        failure: {
          kind: "malformed",
          operation,
          status: response.status,
          code: null,
          message:
            `Syl's own API answered ${operation} with ${String(response.status)} and a body that ` +
            "is not one of the two contract envelopes. Something that is not Syl answered — a " +
            "proxy, or a service that is not the one this client was pointed at.",
          retryable: false,
          details: null,
        },
      };
    }

    if (isFailureBody(parsed)) {
      const { error } = parsed;
      return {
        ok: false,
        failure: {
          kind: "refused",
          operation,
          status: response.status,
          code: error.code,
          message:
            error.code === "UNAUTHORIZED" ? revokedCredential(operation) : error.message,
          retryable: error.retryable,
          details: error.details ?? null,
        },
      };
    }

    if (!isSuccessBody(parsed)) {
      return {
        ok: false,
        failure: {
          kind: "malformed",
          operation,
          status: response.status,
          code: null,
          message:
            `Syl's own API answered ${operation} with ${String(response.status)} and a body that ` +
            "is neither envelope. A success with no `data` reaches a tool as `undefined` wearing " +
            "the right type, which is worse than an error.",
          retryable: false,
          details: null,
        },
      };
    }

    return {
      ok: true,
      // Safe assertion: the envelope is checked above; what `data` holds is the
      // caller's claim about the route it called, exactly as it is for any
      // other typed HTTP client.
      data: parsed.data as T,
      status: response.status,
      replayed: response.headers.get("Idempotency-Replayed") === "true",
    };
  }

  /** Nothing answered, or answered too slowly. */
  #transportFailure(operation: string, error: unknown): ToolFailure {
    const aborted =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    if (aborted) {
      return {
        kind: "timed_out",
        operation,
        status: null,
        code: null,
        message:
          `Syl's own API did not answer ${operation} within ${String(this.#timeoutMs)}ms. ` +
          "The request may still have been carried out, so this is worth checking rather than " +
          "simply repeating.",
        retryable: true,
        details: null,
      };
    }

    return {
      kind: "unreachable",
      operation,
      status: null,
      code: null,
      message:
        `Syl's own API is not answering on ${this.#origin}, so ${operation} did not happen. ` +
        "The service may be restarting.",
      retryable: true,
      details: { cause: error instanceof Error ? error.message : String(error) },
    };
  }
}
