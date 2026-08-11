/**
 * The authenticated transport, and deliberately nothing more.
 *
 * This is the *shell's* half of talking to the backend: attach the bearer
 * header, resolve the URL, and report a rejected key. It returns a raw
 * `Response` and does not parse, type, or classify anything — the typed admin
 * client is `syl-004.1.2`, and it needs the OpenAPI contract that does not
 * exist yet. Building error taxonomies here would mean building them twice.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuthedFetchOptions {
  /** Usually `API_BASE_URL`. */
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: FetchLike | undefined;
  /**
   * Called when the server rejects the credential. The shell wires this to
   * sign-out, so a revoked key returns the operator to the gate instead of
   * leaving them staring at empty panels.
   *
   * **401 only, and 403 deliberately not.** They used to be treated the same,
   * which was right while every route accepted every key. `GET /logs` needs a
   * key with `admin` scope, so 403 now means *this key works and is not for
   * this view* — and signing the operator out over it would drop a perfectly
   * good credential, send them back to the gate, and invite them to paste the
   * same key again. 401 is the only status that means the credential itself
   * was not accepted.
   */
  onUnauthorized?: (() => void) | undefined;
}

export function authorizationHeader(apiKey: string): { Authorization: string } {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    throw new Error("Refusing to build an Authorization header from a blank API key.");
  }
  return { Authorization: `Bearer ${trimmed}` };
}

/** Join a base and a path with exactly one slash between them. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (path.length === 0) return base;
  return `${base}/${path.replace(/^\/+/, "")}`;
}

export function createAuthedFetch(
  options: AuthedFetchOptions,
): (path: string, init?: RequestInit) => Promise<Response> {
  // Built once, so a blank key fails at wiring time rather than on the first
  // request the operator makes.
  const auth = authorizationHeader(options.apiKey);

  return async (path, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    headers.set("Authorization", auth.Authorization);

    const send = options.fetch ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
    const response = await send(joinUrl(options.baseUrl, path), { ...init, headers });

    if (response.status === 401) {
      options.onUnauthorized?.();
    }
    return response;
  };
}
