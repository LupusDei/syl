import { sign } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { randomUUID } from "node:crypto";

import type { DeliveryPayload, PushEnvironment } from "@syl/shared";

import { systemClock, type Clock } from "./clock.js";

/**
 * The APNs sender.
 *
 * Hand-rolled on Node's built-in HTTP/2 rather than wrapped in a library. The
 * wire protocol is one POST and six headers; what a library would add is
 * pooling and retry behaviour designed for fleets, layered underneath the
 * outbox that already owns retry here. A thin codec we can test end to end
 * against a real HTTP/2 server is the better trade, and it matches this
 * repo's existing rule that the protocol layer stays pure and testable.
 *
 * Three properties are load-bearing and each is a documented Apple failure
 * mode rather than an opinion:
 *
 * 1. **One persistent session per host, reused.** Reconnecting per
 *    notification is an explicit anti-pattern; Apple throttles it.
 * 2. **One provider token, regenerated on a timer.** Apple rejects a JWT
 *    whose `iat` is more than an hour old *and* rejects provider-token
 *    updates that arrive too frequently, so signing per request fails in the
 *    other direction.
 * 3. **Per-token environment routing.** The host is chosen by the token's own
 *    environment, never by a server-wide setting. See `device-token-service`.
 *
 * What this module deliberately does **not** do is decide what happens next.
 * It classifies a failure and returns; the outbox owns retry, and the device
 * store owns unregistering. Apple cannot tell us whether a notification
 * arrived — there is no delivery-status API, only a web console — so nothing
 * here may be mistaken for a delivery guarantee.
 */

/** Where each environment's tokens must be sent. */
export const APNS_ORIGINS: Readonly<Record<PushEnvironment, string>> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/**
 * How long a provider token is reused.
 *
 * Apple's window is "older than one hour is rejected" at the top and "updated
 * too frequently is rejected" at the bottom. Thirty minutes sits in the middle
 * of the 20-to-45-minute band Apple's own guidance describes.
 */
export const DEFAULT_TOKEN_REFRESH_MS = 30 * 60_000;

/** How long a single push may take before it is treated as a failure. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

/** The `.p8` key and the identifiers that go with it. */
export interface ApnsCredentials {
  /** The 10-character key id, from the `.p8` filename. */
  readonly keyId: string;
  /** The 10-character Apple team id. */
  readonly teamId: string;
  /** The app's bundle id — the APNs topic. */
  readonly bundleId: string;
  /** PEM contents of the `.p8`. */
  readonly privateKeyPem: string;
}

/**
 * Read APNs credentials from an environment, or `null` if push is not
 * configured on this machine.
 *
 * Returning `null` rather than throwing is deliberate: a developer machine
 * with no `.p8` still has to boot, and the conversation surface, the admin and
 * the harness do not need push. A *half* configuration is a different thing
 * and throws, because the failure it produces at send time is a bare 403 with
 * nothing in it to say which value was missing.
 *
 * @throws {Error} if some but not all of the four values are present.
 */
export function apnsCredentialsFromEnv(env: NodeJS.ProcessEnv): ApnsCredentials | null {
  const names = [
    "SYL_APNS_KEY_ID",
    "SYL_APNS_TEAM_ID",
    "SYL_APNS_BUNDLE_ID",
    "SYL_APNS_PRIVATE_KEY",
  ] as const;

  const values = names.map((name) => {
    const raw = env[name];
    const trimmed = raw?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
  });

  if (values.every((value) => value === undefined)) return null;

  const missing = names.filter((_, index) => values[index] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `APNs is partly configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. ` +
        `Set all four or none — a partial configuration fails at send time as a bare 403.`,
    );
  }

  const [keyId, teamId, bundleId, privateKey] = values;
  return {
    keyId: keyId ?? "",
    teamId: teamId ?? "",
    bundleId: bundleId ?? "",
    // Secret stores flatten a .p8 to one line sooner or later, and a PEM
    // without newlines is not a PEM.
    privateKeyPem: (privateKey ?? "").replace(/\\n/g, "\n"),
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export interface ApnsProviderTokenOptions {
  readonly clock?: Clock;
  readonly refreshMs?: number;
}

/**
 * The ES256 provider token, cached and refreshed on a timer.
 *
 * The signature must be JOSE's raw `r||s`, not the DER encoding Node produces
 * by default — `dsaEncoding: "ieee-p1363"` is what makes the difference, and
 * getting it wrong produces a 403 that looks exactly like a wrong key.
 */
export class ApnsProviderToken {
  readonly #credentials: ApnsCredentials;
  readonly #clock: Clock;
  readonly #refreshMs: number;
  #cached: string | null = null;
  #issuedAt = 0;
  #signCount = 0;

  constructor(credentials: ApnsCredentials, options: ApnsProviderTokenOptions = {}) {
    this.#credentials = credentials;
    this.#clock = options.clock ?? systemClock;
    this.#refreshMs = options.refreshMs ?? DEFAULT_TOKEN_REFRESH_MS;
  }

  /** How many times a token has actually been signed. For tests and metrics. */
  get signCount(): number {
    return this.#signCount;
  }

  /** The current token, signing a fresh one only when the window has passed. */
  token(): string {
    const now = this.#clock();
    if (this.#cached !== null && now - this.#issuedAt < this.#refreshMs) return this.#cached;

    const header = base64url(
      JSON.stringify({ alg: "ES256", kid: this.#credentials.keyId }),
    );
    const payload = base64url(
      JSON.stringify({ iss: this.#credentials.teamId, iat: Math.floor(now / 1000) }),
    );
    const signature = sign(
      "sha256",
      Buffer.from(`${header}.${payload}`, "utf8"),
      { key: this.#credentials.privateKeyPem, dsaEncoding: "ieee-p1363" },
    );

    this.#cached = `${header}.${payload}.${base64url(signature)}`;
    this.#issuedAt = now;
    this.#signCount += 1;
    return this.#cached;
  }

  /**
   * Throw the cached token away.
   *
   * Called when Apple answers `ExpiredProviderToken`, which can happen before
   * our own window elapses if the machine's clock has moved.
   */
  invalidate(): void {
    this.#cached = null;
  }
}

/** What to do about a rejected push. */
export type ApnsDisposition = "unregister" | "retry" | "permanent";

/**
 * A transport-level failure, before Apple ever answered.
 *
 * Given a status of 0 so it travels through the same shape as a rejection.
 * The Mac being mid-reboot and Apple being down are the same event from here,
 * and both are retryable.
 */
const TRANSPORT_FAILURE = 0;

/** Reasons that mean this token will never work again. */
const DEAD_TOKEN_REASONS: ReadonlySet<string> = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

/** Reasons that are about this moment rather than this token or this config. */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  "ConnectionFailed",
  "ExpiredProviderToken",
  "TooManyProviderTokenUpdates",
  "TooManyRequests",
  "IdleTimeout",
  "ServiceUnavailable",
  "InternalServerError",
  "Shutdown",
]);

/**
 * Decide what a rejection means.
 *
 * The three-way split matters because each answer has a different cost of
 * being wrong: retrying a dead token forever wastes the outbox, unregistering
 * on a transient error silently stops all delivery to his phone, and retrying
 * a wrong bundle id floods Apple with requests that cannot succeed.
 */
export function classifyApnsFailure(status: number, reason: string): ApnsDisposition {
  if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) return "unregister";
  if (TRANSIENT_REASONS.has(reason)) return "retry";
  // Status zero means Apple never answered — the connection failed, or the
  // request timed out. "We do not know" is always retryable: concluding
  // anything about a token from a connection we never made would let a
  // rebooting Mac unregister the Commander's phone.
  if (status === TRANSPORT_FAILURE || status === 429 || status >= 500) return "retry";
  return "permanent";
}

/**
 * Build the JSON body of a notification.
 *
 * `data` becomes top-level custom keys alongside `aps`, which is where the
 * delivery id travels — the device needs it to acknowledge, and the
 * acknowledgement is what marks the row delivered.
 */
export function buildApnsBody(
  payload: DeliveryPayload,
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
    sound: "default",
    "interruption-level": payload.interruptionLevel ?? "active",
  };
  if (payload.categoryIdentifier != null) aps["category"] = payload.categoryIdentifier;
  if (payload.threadIdentifier != null) aps["thread-id"] = payload.threadIdentifier;

  return { aps, ...data };
}

/** One notification to send. */
export interface ApnsNotification {
  readonly token: string;
  readonly environment: PushEnvironment;
  readonly payload: DeliveryPayload;
  /** Custom keys carried alongside `aps`, typically the delivery id. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** `apns-id`. Ours, so a retry is recognisably the same notification. */
  readonly apnsId?: string;
  /** `apns-collapse-id`. Same id replaces an undelivered notification. */
  readonly collapseId?: string;
  readonly timeoutMs?: number;
}

/** What a send produced. */
export type ApnsResult =
  | { readonly ok: true; readonly apnsUniqueId: string | null; readonly apnsId: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly reason: string;
      readonly disposition: ApnsDisposition;
    };

export interface ApnsClientOptions {
  readonly credentials: ApnsCredentials;
  /** Overridable so tests can point at a local HTTP/2 server. */
  readonly origins?: Readonly<Record<PushEnvironment, string>>;
  readonly clock?: Clock;
  readonly tokenRefreshMs?: number;
  readonly timeoutMs?: number;
}

export class ApnsClient {
  readonly #credentials: ApnsCredentials;
  readonly #origins: Readonly<Record<PushEnvironment, string>>;
  readonly #provider: ApnsProviderToken;
  readonly #timeoutMs: number;
  readonly #sessions = new Map<string, ClientHttp2Session>();

  constructor(options: ApnsClientOptions) {
    this.#credentials = options.credentials;
    this.#origins = options.origins ?? APNS_ORIGINS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.#provider = new ApnsProviderToken(options.credentials, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.tokenRefreshMs === undefined ? {} : { refreshMs: options.tokenRefreshMs }),
    });
  }

  /** Push one notification. Never throws; a failure is a value. */
  async send(notification: ApnsNotification): Promise<ApnsResult> {
    const apnsId = notification.apnsId ?? randomUUID();
    const origin = this.#origins[notification.environment];
    const body = JSON.stringify(
      buildApnsBody(notification.payload, notification.data ?? {}),
    );

    let session: ClientHttp2Session;
    try {
      session = this.#session(origin);
    } catch {
      return this.#failure(TRANSPORT_FAILURE, "ConnectionFailed");
    }

    const headers = {
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${notification.token}`,
      [constants.HTTP2_HEADER_SCHEME]: origin.startsWith("https") ? "https" : "http",
      authorization: `bearer ${this.#provider.token()}`,
      "apns-topic": this.#credentials.bundleId,
      // alert + priority 10 is the only combination that is neither throttled
      // against a device battery budget nor dropped in Low Power Mode.
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-id": apnsId,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(notification.collapseId === undefined
        ? {}
        : { "apns-collapse-id": notification.collapseId }),
    };

    const result = await this.#request(
      session,
      headers,
      body,
      notification.timeoutMs ?? this.#timeoutMs,
      apnsId,
    );

    // An expired provider token is not about this notification; drop the
    // cached JWT so the retry signs a fresh one.
    if (!result.ok && result.reason === "ExpiredProviderToken") this.#provider.invalidate();

    return result;
  }

  /** Close every session. Idempotent. */
  async close(): Promise<void> {
    await this.dropSessions();
  }

  /**
   * Tear down every open session.
   *
   * Exposed rather than private because a wedged session is a real operational
   * state — Apple's `GOAWAY`, a network change, a tunnel restart — and the
   * next send must transparently reconnect.
   */
  async dropSessions(): Promise<void> {
    const closing = [...this.#sessions.values()].map(
      (session) =>
        new Promise<void>((resolve) => {
          if (session.closed || session.destroyed) {
            resolve();
            return;
          }
          session.close(() => resolve());
        }),
    );
    this.#sessions.clear();
    await Promise.all(closing);
  }

  #failure(status: number, reason: string): ApnsResult {
    return { ok: false, status, reason, disposition: classifyApnsFailure(status, reason) };
  }

  /** The session for an origin, connecting if there is not one. */
  #session(origin: string): ClientHttp2Session {
    const existing = this.#sessions.get(origin);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;

    const session = connect(origin);
    // An idle session must not hold the process open on its own. The service
    // stays alive because it is listening; the sender is not a reason to run.
    session.unref();
    // A connection error surfaces on the request, not here: swallowing it at
    // the session level is what stops an unreachable Mac from becoming an
    // unhandled rejection that takes the process down.
    session.on("error", () => this.#forget(origin, session));
    session.on("close", () => this.#forget(origin, session));
    session.on("goaway", () => this.#forget(origin, session));

    this.#sessions.set(origin, session);
    return session;
  }

  #forget(origin: string, session: ClientHttp2Session): void {
    if (this.#sessions.get(origin) === session) this.#sessions.delete(origin);
  }

  /** One request/response exchange, reduced to an {@link ApnsResult}. */
  #request(
    session: ClientHttp2Session,
    headers: Record<string, string | number>,
    body: string,
    timeoutMs: number,
    apnsId: string,
  ): Promise<ApnsResult> {
    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      const settle = (result: ApnsResult): void => {
        if (settled) return;
        settled = true;
        // A session with nothing in flight goes back to not holding the
        // process open.
        session.unref();
        resolve(result);
      };

      let stream;
      try {
        // Referenced only while a request is in flight, so an awaited send
        // cannot be starved by the event loop emptying.
        session.ref();
        stream = session.request(headers);
      } catch {
        settle(this.#failure(TRANSPORT_FAILURE, "ConnectionFailed"));
        return;
      }

      let status = 0;
      let uniqueId: string | null = null;
      const chunks: Buffer[] = [];

      stream.setTimeout(timeoutMs, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        settle(this.#failure(TRANSPORT_FAILURE, "IdleTimeout"));
      });

      stream.on("response", (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0);
        const unique = responseHeaders["apns-unique-id"];
        uniqueId = typeof unique === "string" ? unique : null;
      });

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", () => settle(this.#failure(TRANSPORT_FAILURE, "ConnectionFailed")));

      stream.on("end", () => {
        if (status === 200) {
          settle({ ok: true, apnsUniqueId: uniqueId, apnsId });
          return;
        }

        let reason = `HTTP ${status}`;
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof parsed === "object" && parsed !== null) {
            // Safe assertion: guarded above, and the field is type-tested.
            const value = (parsed as Record<string, unknown>)["reason"];
            if (typeof value === "string") reason = value;
          }
        } catch {
          // Apple always sends JSON on a failure, but a proxy in the way might
          // not. The status alone still classifies.
        }
        settle(this.#failure(status, reason));
      });

      stream.end(body);
    });
  }
}
