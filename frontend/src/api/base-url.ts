/**
 * Where the admin sends its requests.
 *
 * The default is the relative path `/api/v1`, which the dev server proxies to
 * the backend on 8888 (see `vite.config.ts`). Relative by default means the
 * browser stays same-origin, so there is no CORS configuration to get wrong
 * and the same build works behind any reverse proxy. Point it somewhere else
 * with `VITE_API_BASE_URL`.
 *
 * **It ends at the version prefix**, matching `servers[].url` in
 * `shared/openapi.yaml` — so `VITE_API_BASE_URL=http://127.0.0.1:4210/api/v1`
 * points the admin at `npm run mock` verbatim, and every path the client
 * builds is the operation path from the contract with nothing prepended.
 */
export const DEFAULT_API_BASE_URL = "/api/v1";

export function resolveApiBaseUrl(env: Record<string, string | undefined>): string {
  const configured = env["VITE_API_BASE_URL"]?.trim() ?? "";
  // Trailing slashes are stripped so `joinUrl` never produces a doubled one.
  const normalised = configured.replace(/\/+$/, "");
  return normalised.length === 0 ? DEFAULT_API_BASE_URL : normalised;
}

/** Resolved once at module load; the value cannot change without a reload. */
export const API_BASE_URL: string = resolveApiBaseUrl(
  // Safe: Vite inlines `import.meta.env` at build time as a plain object whose
  // `VITE_*` members are strings or absent. `ImportMetaEnv` declares typed
  // built-ins (MODE, DEV, …) which is why it is not assignable directly;
  // `resolveApiBaseUrl` reads one key and tolerates it being missing.
  import.meta.env as unknown as Record<string, string | undefined>,
);
