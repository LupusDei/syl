/**
 * The typed admin client.
 *
 * Every shape here comes from `@syl/shared/types`, which is generated from
 * `shared/openapi.yaml`. **Nothing in this file describes a payload**, and
 * that is the point: the frontend, the backend and SylKit are measured
 * against one contract, and a hand-written interface on this side would be a
 * fourth opinion that drifts silently.
 *
 * It is **read-only**. Every write in the contract requires an
 * `Idempotency-Key`, and this client retries; the two go together or not at
 * all. The admin is an instrument for looking at the system, so the surface
 * it needs is the one it has.
 *
 * Transport, credential, and sign-out-on-401 belong to `authed-fetch.ts`.
 * This layer adds the three things that were deliberately left out of it:
 * URL and query construction, envelope unwrapping into contract types, and
 * the retry policy.
 */

import type {
  Conversation,
  ConversationLane,
  ConversationPage,
  Delivery,
  DeliveryPage,
  DeliveryState,
  DevicePage,
  HealthStatus,
  Id,
  Job,
  JobKind,
  JobPage,
  JobState,
  LogLevel,
  LogPage,
  MessagePage,
  Run,
  RunPage,
} from "@syl/shared/types";

import type { AuthedRequest } from "./use-authed-fetch";
import { malformedResponse, networkFailure, unwrapEnvelope } from "./errors";
import { withRetry, type RetryOptions } from "./retry";

/** Cursor pagination, identical on every list endpoint. */
export interface PageParams {
  readonly cursor?: string | null | undefined;
  readonly limit?: number | undefined;
}

export interface JobListParams extends PageParams {
  readonly state?: JobState | undefined;
  readonly kind?: JobKind | undefined;
}

export interface DeliveryListParams extends PageParams {
  readonly state?: DeliveryState | undefined;
  /** Only rows with a null `ackedAt` — the outbox view that matters. */
  readonly unacknowledged?: boolean | undefined;
}

export interface ConversationListParams extends PageParams {
  readonly lane?: ConversationLane | undefined;
}

/**
 * The log filters, as the contract spells them.
 *
 * `event` is a **prefix**: `turn` is every turn event, `turn.tool` is only the
 * tool calls. The distinction is the whole usefulness of the filter and is
 * documented here because a caller reading only this file would otherwise
 * assume equality and quietly get nothing.
 */
export interface LogListParams extends PageParams {
  readonly event?: string | undefined;
  readonly level?: LogLevel | undefined;
  /** Inclusive lower bound, RFC 3339. */
  readonly since?: string | undefined;
  /** Inclusive upper bound, RFC 3339. */
  readonly until?: string | undefined;
}

export interface MessageListParams extends PageParams {
  /** `backward` (the default) walks into history. */
  readonly direction?: "backward" | "forward" | undefined;
}

/** Per-call options. `signal` is how a view cancels a request it navigated away from. */
export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface AdminClient {
  health(options?: CallOptions): Promise<HealthStatus>;

  listJobs(params?: JobListParams, options?: CallOptions): Promise<JobPage>;
  getJob(jobId: Id, options?: CallOptions): Promise<Job>;
  listJobRuns(jobId: Id, params?: PageParams, options?: CallOptions): Promise<RunPage>;
  getRun(runId: Id, options?: CallOptions): Promise<Run>;

  listDeliveries(params?: DeliveryListParams, options?: CallOptions): Promise<DeliveryPage>;
  getDelivery(deliveryId: Id, options?: CallOptions): Promise<Delivery>;

  listConversations(
    params?: ConversationListParams,
    options?: CallOptions,
  ): Promise<ConversationPage>;
  getConversation(conversationId: Id, options?: CallOptions): Promise<Conversation>;
  listMessages(
    conversationId: Id,
    params?: MessageListParams,
    options?: CallOptions,
  ): Promise<MessagePage>;

  listDevices(params?: PageParams, options?: CallOptions): Promise<DevicePage>;

  /**
   * The service's own log. **Needs a key with `admin` scope.**
   *
   * The only call on this client that a device token cannot make: it answers
   * `403 FORBIDDEN`, which `unwrapEnvelope` surfaces as an ordinary API error
   * rather than signing the session out — a device key is a *working* key for
   * every other view, and dropping it would be the wrong response.
   */
  listLogs(params?: LogListParams, options?: CallOptions): Promise<LogPage>;
}

export interface AdminClientOptions extends RetryOptions {
  /** Usually `useAuthedFetch()`. */
  readonly request: AuthedRequest;
}

type QueryValue = string | number | boolean | null | undefined;

/**
 * Append the parameters that were actually supplied.
 *
 * Omitted and null values are dropped rather than sent empty: `?state=` is a
 * filter on the empty string as far as a server is concerned, and the mock
 * treats it exactly that way.
 */
export function withQuery(path: string, params: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

/** Ids carry colons (`syl:job:…`); the mock decodes path parameters, so encode them. */
function segment(id: Id): string {
  return encodeURIComponent(id);
}

function isAbort(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "AbortError";
}

export function createAdminClient(options: AdminClientOptions): AdminClient {
  const { request, ...retry } = options;

  async function once<T>(path: string, call: CallOptions | undefined): Promise<T> {
    let response: Response;
    try {
      response = await request(path, call?.signal === undefined ? undefined : { signal: call.signal });
    } catch (cause: unknown) {
      // A cancelled view is not a failure, and wrapping it would make the
      // retry loop treat navigation as a transient network fault.
      if (isAbort(cause)) throw cause;
      throw networkFailure(cause);
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw malformedResponse(response.status, "the body was not JSON");
    }
    return unwrapEnvelope<T>(response.status, body);
  }

  function get<T>(
    path: string,
    params: Readonly<Record<string, QueryValue>>,
    call: CallOptions | undefined,
  ): Promise<T> {
    const url = withQuery(path, params);
    return withRetry(() => once<T>(url, call), retry);
  }

  const pageParams = (params: PageParams | undefined): Record<string, QueryValue> => ({
    cursor: params?.cursor,
    limit: params?.limit,
  });

  return {
    health: (call) => get<HealthStatus>("/health", {}, call),

    listJobs: (params, call) =>
      get<JobPage>("/jobs", { ...pageParams(params), state: params?.state, kind: params?.kind }, call),
    getJob: (jobId, call) => get<Job>(`/jobs/${segment(jobId)}`, {}, call),
    listJobRuns: (jobId, params, call) =>
      get<RunPage>(`/jobs/${segment(jobId)}/runs`, pageParams(params), call),
    getRun: (runId, call) => get<Run>(`/runs/${segment(runId)}`, {}, call),

    listDeliveries: (params, call) =>
      get<DeliveryPage>(
        "/deliveries",
        {
          ...pageParams(params),
          state: params?.state,
          unacknowledged: params?.unacknowledged,
        },
        call,
      ),
    getDelivery: (deliveryId, call) => get<Delivery>(`/deliveries/${segment(deliveryId)}`, {}, call),

    listConversations: (params, call) =>
      get<ConversationPage>("/conversations", { ...pageParams(params), lane: params?.lane }, call),
    getConversation: (conversationId, call) =>
      get<Conversation>(`/conversations/${segment(conversationId)}`, {}, call),
    listMessages: (conversationId, params, call) =>
      get<MessagePage>(
        `/conversations/${segment(conversationId)}/messages`,
        { ...pageParams(params), direction: params?.direction },
        call,
      ),

    listDevices: (params, call) => get<DevicePage>("/devices", pageParams(params), call),

    listLogs: (params, call) =>
      get<LogPage>(
        "/logs",
        {
          ...pageParams(params),
          event: params?.event,
          level: params?.level,
          since: params?.since,
          until: params?.until,
        },
        call,
      ),
  };
}
