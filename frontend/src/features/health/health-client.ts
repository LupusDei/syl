/**
 * The health surface's own client.
 *
 * ## Why this is not in `api/client.ts`
 *
 * The same reason `memory-client.ts` gives, and it is the load-bearing one:
 * `api/client.ts` "describes no payload of its own", which is what keeps the
 * frontend, the backend and SylKit measured against one spec. `GET
 * /health/series` is not in `shared/openapi.yaml` yet, so a hand-written shape
 * there would break the rule that file exists to hold. It lives here,
 * quarantined, until the operation is added to the spec.
 *
 * Unlike the memory client this one is **read-only**, so it can reuse
 * `retry.ts` unconditionally: the precondition that file names — "a write
 * surface must set an idempotency key before it may reuse this" — does not
 * arise. The phone writes health data; the admin only looks at it.
 *
 * Transport, credential and sign-out-on-401 still belong to `authed-fetch.ts`.
 */

import { malformedResponse, networkFailure, unwrapEnvelope } from "../../api/errors";
import { withRetry, type RetryOptions } from "../../api/retry";
import type { AuthedRequest } from "../../api/use-authed-fetch";
import {
  AUTHORISATION_STATES,
  isHealthType,
  type AuthorisationState,
  type HealthSample,
  type HealthSeries,
  type HealthType,
} from "./health-model";

export interface SeriesParams {
  readonly type: HealthType;
  /** Inclusive lower bound on `startedAt`, RFC 3339. */
  readonly from?: string | undefined;
  /** Exclusive upper bound on `startedAt`, RFC 3339. */
  readonly to?: string | undefined;
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface HealthClient {
  series(params: SeriesParams, options?: CallOptions): Promise<HealthSeries>;
}

export interface HealthClientOptions extends RetryOptions {
  readonly request: AuthedRequest;
}

function withQuery(path: string, params: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, value);
  }
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function isAbort(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "AbortError"
  );
}

function isAuthorisationState(value: unknown): value is AuthorisationState {
  return typeof value === "string" && (AUTHORISATION_STATES as readonly string[]).includes(value);
}

/**
 * Re-check the one field the whole view branches on.
 *
 * Every other viewer here trusts the envelope, because every other viewer reads
 * a shape the contract suite already validates. This one does not have that
 * safety net yet, and the field it would be trusting blindly is the one that
 * decides whether an empty chart is a statement about his body. A missing or
 * misspelled `state` must land as **`unreported`** — "we have never been told" —
 * and never as a silent `authorised`.
 *
 * `silenceIsEvidence` is likewise coerced rather than defaulted: anything that
 * is not literally `true` is `false`. Fail closed, in the direction where being
 * wrong costs a hatched panel instead of a lie.
 */
function asSeries(type: HealthType, payload: unknown, status: number): HealthSeries {
  if (typeof payload !== "object" || payload === null) {
    throw malformedResponse(status, "the series payload was not an object");
  }
  const raw = payload as Record<string, unknown>;

  const answeredType = raw["type"];
  if (!isHealthType(answeredType) || answeredType !== type) {
    // A series answered under a different type would be charted under the wrong
    // heading, which is a worse failure than no chart at all.
    throw malformedResponse(
      status,
      `asked for ${type} and the answer named ${String(answeredType)}`,
    );
  }

  const samples = raw["samples"];
  if (!Array.isArray(samples)) {
    throw malformedResponse(status, "the series carried no `samples` array");
  }

  const state = raw["state"];
  return {
    type,
    unit: typeof raw["unit"] === "string" ? raw["unit"] : "",
    state: isAuthorisationState(state) ? state : null,
    reportedAt: typeof raw["reportedAt"] === "string" ? raw["reportedAt"] : null,
    silenceIsEvidence: raw["silenceIsEvidence"] === true,
    watermark: typeof raw["watermark"] === "string" ? raw["watermark"] : null,
    // Rows are not re-validated one by one: a bad row is a store bug, and the
    // cost of being wrong about one of thirty thousand is a dash in a cell.
    // Safe assertion — the array-ness is proven above.
    samples: samples as readonly HealthSample[],
  };
}

export function createHealthClient(options: HealthClientOptions): HealthClient {
  const { request, ...retry } = options;

  async function once(params: SeriesParams, call: CallOptions | undefined): Promise<HealthSeries> {
    const path = withQuery("/health/series", {
      type: params.type,
      from: params.from,
      to: params.to,
    });

    let response: Response;
    try {
      response = await request(path, {
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
    return asSeries(params.type, unwrapEnvelope<unknown>(response.status, body), response.status);
  }

  return {
    series: (params, call) => withRetry(() => once(params, call), retry),
  };
}
