/**
 * The memory surface's own client.
 *
 * ## Why this is not in `api/client.ts`
 *
 * Two reasons, and both are stated in that file rather than invented here.
 *
 * 1. **`AdminClient` is deliberately read-only.** "Every write in the contract
 *    requires an `Idempotency-Key`, and this client retries; the two go together
 *    or not at all." This surface is a *correction* surface — the whole point is
 *    that it writes — so it does the thing `retry.ts` names as the precondition:
 *    it mints a key **once per operation** and reuses it across every retry, so
 *    a timeout can never become a second rejection.
 * 2. **Nothing here is in the contract yet.** `api/client.ts` says "nothing in
 *    this file describes a payload", which is what keeps the frontend, the
 *    backend and SylKit measured against one spec. The memory routes are not in
 *    `shared/openapi.yaml` yet, so putting hand-written shapes there would break
 *    the one rule that file exists to hold. They live here, quarantined, until
 *    `syl-q9n` adds the operations to the spec.
 *
 * Transport, credential and sign-out-on-401 still belong to `authed-fetch.ts`.
 * This layer adds only URL construction, envelope unwrapping and the key.
 */

import { malformedResponse, networkFailure, unwrapEnvelope } from "../../api/errors";
import { withRetry, type RetryOptions } from "../../api/retry";
import type { AuthedRequest } from "../../api/use-authed-fetch";
import type { MemoryFeedbackResult, MemoryGraphView, MemoryMetricsView, Verdict } from "./memory-model";

export interface GraphParams {
  /** Hot nodes seeding the walk. */
  readonly nodes?: number | undefined;
  /** The edge budget. */
  readonly edges?: number | undefined;
  /** Nights of dream output. */
  readonly nights?: number | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface MemoryClient {
  graph(params?: GraphParams, options?: CallOptions): Promise<MemoryGraphView>;
  metrics(options?: CallOptions): Promise<MemoryMetricsView>;
  /**
   * Tell Syl she was right, or that she was wrong.
   *
   * `confirm` is the engagement touch — the only path an edge has to a weight
   * above Syl's own internal cap. `reject` suppresses: the edge leaves every
   * scan and its weight drops below the relevance floor in one move.
   */
  judge(edgeId: string, verdict: Verdict, options?: CallOptions): Promise<MemoryFeedbackResult>;
}

export interface MemoryClientOptions extends RetryOptions {
  readonly request: AuthedRequest;
  /** Injectable so a test can assert the key travels and is stable per call. */
  readonly newKey?: (() => string) | undefined;
}

/**
 * A key for one operation.
 *
 * `crypto.randomUUID` where it exists — every browser this admin runs in has it
 * on a secure origin. The fallback is not decorative: a page served over plain
 * HTTP on the tailnet has no `crypto.subtle`, and a client that threw there
 * would make the correction surface unusable exactly where it is used.
 */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof uuid?.randomUUID === "function") return uuid.randomUUID();
  return `syl-admin-${String(Date.now())}-${Math.random().toString(36).slice(2, 12)}`;
}

type QueryValue = string | number | undefined;

function withQuery(path: string, params: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function isAbort(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "AbortError";
}

export function createMemoryClient(options: MemoryClientOptions): MemoryClient {
  const { request, newKey, ...retry } = options;
  const mintKey = newKey ?? newIdempotencyKey;

  async function once<T>(path: string, init: RequestInit | undefined, call: CallOptions | undefined): Promise<T> {
    let response: Response;
    try {
      response = await request(path, {
        ...init,
        ...(call?.signal === undefined ? {} : { signal: call.signal }),
      });
    } catch (cause: unknown) {
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

  return {
    graph: (params, call) =>
      withRetry(
        () =>
          once<MemoryGraphView>(
            withQuery("/memory/graph", {
              nodes: params?.nodes,
              edges: params?.edges,
              nights: params?.nights,
            }),
            undefined,
            call,
          ),
        retry,
      ),

    metrics: (call) => withRetry(() => once<MemoryMetricsView>("/memory/metrics", undefined, call), retry),

    judge: (edgeId, verdict, call) => {
      // Minted ONCE, outside the retry loop. Inside it, a retried timeout
      // would mint a second key and reject the same edge twice — which is the
      // exact failure `retry.ts` says a write surface must prevent before it
      // may reuse the policy.
      const key = mintKey();
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ verdict }),
      };
      return withRetry(
        () =>
          once<MemoryFeedbackResult>(
            `/memory/edges/${encodeURIComponent(edgeId)}/feedback`,
            init,
            call,
          ),
        retry,
      );
    },
  };
}
