import { useMemo } from "react";

import { useAuth } from "../auth/AuthProvider";
import { createAuthedFetch } from "./authed-fetch";
import { API_BASE_URL } from "./base-url";

export type AuthedRequest = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The shell's half of talking to the backend: the stored key, the configured
 * base URL, and sign-out wired to a rejected credential.
 *
 * Returns `null` when there is no key, which is only reachable if a caller
 * renders outside the gate — the type makes that case impossible to forget.
 *
 * The typed admin client (`syl-004.1.2`) builds on this; it does not replace
 * it, because credential handling belongs with the auth surface that owns the
 * key rather than with the code that knows the endpoint shapes.
 */
export function useAuthedFetch(): AuthedRequest | null {
  const { apiKey, signOut } = useAuth();

  return useMemo(() => {
    if (apiKey === null) return null;
    return createAuthedFetch({
      baseUrl: API_BASE_URL,
      apiKey,
      onUnauthorized: signOut,
    });
  }, [apiKey, signOut]);
}
