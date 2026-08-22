/**
 * The Runway realtime-sessions HTTP client — the one place the secret lives.
 *
 * A thin, signed wrapper over the three endpoints a face needs:
 *
 * ```
 * POST /v1/realtime_sessions                        create a gwm1_avatars session
 * GET  /v1/realtime_sessions/{id}                   poll it to READY
 * POST /v1/realtime_sessions/{id}/connect_backend   join its LiveKit room as us
 * ```
 *
 * It owns **no** lifecycle — polling, cost gating and accounting are
 * `face-session-broker.ts`'s job. This layer signs, shapes the body, and turns
 * a non-2xx into a typed error.
 *
 * ## The secret
 *
 * `RUNWAYML_API_SECRET` is read here and **never leaves the server**. Only the
 * short-lived `sessionKey` (`stk_…`) crosses the boundary to a browser or a
 * phone, and that happens in the broker and the route, not here.
 *
 * The error path is part of that promise and is easy to get wrong: an upstream
 * that echoes a bad `Authorization` header back in its body would otherwise put
 * the secret into an exception message, a log line and a 502 response in one
 * step. {@link safeDetail} redacts it before it can become any of those.
 */

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_API_VERSION = "2024-11-06";

/** The realtime avatar model. Her avatar is a `custom` character on it. */
export const RUNWAY_AVATAR_MODEL = "gwm1_avatars";

/**
 * The provider's hard ceiling on a `backend_rpc` handler, in seconds.
 *
 * **8, and it is the design constraint on the whole ingress.** Her warm turn is
 * ~1,635ms and a cold spawn is ~7,450ms — so a cold path does not fit, and
 * `ask-syl.ts` refuses one rather than gambling on it. Verified against
 * Runway's tool schema; a value above this is rejected at session-create.
 */
export const RUNWAY_RPC_MAX_TIMEOUT_SECONDS = 8;

export interface RunwayClientOptions {
  /** The org secret. Defaults to `RUNWAYML_API_SECRET`. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  /** Injected for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** Which avatar speaks. Hers is `custom`, bound to her face and her voice. */
export interface RunwayAvatarSelector {
  readonly type: string;
  readonly avatarId: string;
}

/** One declared parameter of a `backend_rpc` tool, as the model sees it. */
export interface RunwayRpcToolParam {
  readonly name: string;
  /** `"string"`, `"number"`, `"boolean"`. There is no enum field in the schema. */
  readonly type: string;
  readonly description: string;
}

/**
 * A tool the avatar's model may call mid-conversation.
 *
 * Declared at session-create so the model knows it exists. The handler runs in
 * **our** process: `@runwayml/avatars-node-rpc` joins the session's LiveKit
 * room as an extra participant and registers the method there. See
 * `ask-syl.ts` — the call arrives over a socket we dialled OUT on, not over an
 * inbound request.
 *
 * At most 20 parameters, and `timeoutSeconds` at most
 * {@link RUNWAY_RPC_MAX_TIMEOUT_SECONDS}.
 */
export interface RunwayRpcToolDef {
  readonly type: "backend_rpc";
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly RunwayRpcToolParam[];
  readonly timeoutSeconds: number;
}

/** Runway's cap on how many parameters one tool may declare. */
export const RUNWAY_RPC_MAX_PARAMETERS = 20;

export interface CreateRealtimeSessionInput {
  readonly avatar: RunwayAvatarSelector;
  /** Defaults to {@link RUNWAY_AVATAR_MODEL}. */
  readonly model?: string;
  /** Tools the model may call. Sent only when non-empty. */
  readonly tools?: readonly RunwayRpcToolDef[];
}

/** A realtime session row. Fields appear progressively as it readies. */
export interface RealtimeSessionRow {
  readonly id: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  /** `stk_…`, present once READY. The only credential that may go outward. */
  readonly sessionKey?: string;
}

/** LiveKit room-join credentials for an existing session. */
export interface LiveKitConnectCreds {
  readonly url: string;
  readonly token: string;
  readonly roomName: string;
  readonly expiresAt?: string;
}

/** A non-2xx from Runway, with the status and a redacted body. */
export class RunwayApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(operation: string, status: number, detail: string) {
    super(`Runway ${operation} failed (HTTP ${String(status)}): ${detail}`);
    this.name = "RunwayApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The narrow slice of the client the broker depends on, so it can be faked. */
export interface RunwaySessionApi {
  createRealtimeSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionRow>;
  getRealtimeSession(sessionId: string): Promise<RealtimeSessionRow>;
  connectBackend(sessionId: string): Promise<LiveKitConnectCreds>;
}

export class RunwayClient implements RunwaySessionApi {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: RunwayClientOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env["RUNWAYML_API_SECRET"] ?? "";
    this.#baseUrl = options.baseUrl ?? RUNWAY_BASE;
    this.#apiVersion = options.apiVersion ?? RUNWAY_API_VERSION;
    this.#fetch = options.fetchImpl ?? fetch;

    if (this.#apiKey === "") {
      throw new Error(
        "RUNWAYML_API_SECRET is not configured, so no face session can be created. " +
          "Refusing to send an unauthenticated request rather than failing at the provider.",
      );
    }
  }

  async createRealtimeSession(input: CreateRealtimeSessionInput): Promise<RealtimeSessionRow> {
    const body: Record<string, unknown> = {
      model: input.model ?? RUNWAY_AVATAR_MODEL,
      avatar: input.avatar,
    };
    // Attached only when supplied, so the proven base body stays byte-identical.
    if (input.tools !== undefined && input.tools.length > 0) body["tools"] = input.tools;

    const response = await this.#fetch(`${this.#baseUrl}/realtime_sessions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new RunwayApiError("session create", response.status, await this.#safeDetail(response));
    }
    return (await response.json()) as RealtimeSessionRow;
  }

  async getRealtimeSession(sessionId: string): Promise<RealtimeSessionRow> {
    const response = await this.#fetch(
      `${this.#baseUrl}/realtime_sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET", headers: this.#headers() },
    );
    if (!response.ok) {
      throw new RunwayApiError("session fetch", response.status, await this.#safeDetail(response));
    }
    return (await response.json()) as RealtimeSessionRow;
  }

  /**
   * Join an existing session's LiveKit room as an additional participant.
   *
   * This is what `@runwayml/avatars-node-rpc` uses to add its hidden RPC
   * participant, and it is why the `ask_syl` ingress needs no inbound network
   * exposure: the credentials come back here, and **we** dial out to LiveKit.
   *
   * It creates no second realtime session and charges no second upfront credit.
   */
  async connectBackend(sessionId: string): Promise<LiveKitConnectCreds> {
    const response = await this.#fetch(
      `${this.#baseUrl}/realtime_sessions/${encodeURIComponent(sessionId)}/connect_backend`,
      { method: "POST", headers: this.#headers(), body: JSON.stringify({}) },
    );
    if (!response.ok) {
      throw new RunwayApiError(
        "session connect_backend",
        response.status,
        await this.#safeDetail(response),
      );
    }
    return (await response.json()) as LiveKitConnectCreds;
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      "X-Runway-Version": this.#apiVersion,
      "Content-Type": "application/json",
    };
  }

  /**
   * A short, **redacted** slice of an error body.
   *
   * An upstream that echoes the `Authorization` header back is the shortest
   * path from "the secret never leaves the server" to the secret sitting in a
   * log file, an exception message and a 502 body at once. Redacting here is
   * the only place that covers all three.
   */
  async #safeDetail(response: Response): Promise<string> {
    let text: string;
    try {
      text = (await response.text()).slice(0, 300);
    } catch {
      return "<no body>";
    }
    return text.split(this.#apiKey).join("<redacted>");
  }
}
