import { useMemo } from "react";

import { createAdminClient, type AdminClient } from "./client";
import { useAuthedFetch } from "./use-authed-fetch";

/**
 * The typed client, wired to the stored key.
 *
 * `null` while the operator is signed out, mirroring `useAuthedFetch` — the
 * type makes "render a viewer outside the gate" impossible to forget rather
 * than something that shows up as an empty panel.
 */
export function useAdminClient(): AdminClient | null {
  const request = useAuthedFetch();
  return useMemo(() => (request === null ? null : createAdminClient({ request })), [request]);
}
