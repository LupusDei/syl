import type { StorageLike } from "../storage";

/**
 * Where the admin API key is remembered between reloads.
 *
 * It is a *credential in a browser*, so be clear about what this is and is
 * not: it is a development instrument's key, kept in origin-scoped storage so
 * the operator does not retype it on every reload. It is never sent anywhere
 * except as a bearer header to the configured API base URL, and `clearApiKey`
 * is reachable from the chrome at all times.
 */
export const API_KEY_STORAGE_KEY = "syl.admin.api-key";

/** The stored key, or `null` when there is nothing usable stored. */
export function readApiKey(storage: StorageLike): string | null {
  const raw = storage.getItem(API_KEY_STORAGE_KEY);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Store a key. Throws on a blank one rather than persist a credential that
 * would only ever produce `Bearer ` and a confusing 401.
 */
export function writeApiKey(storage: StorageLike, key: string): void {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error("Refusing to store a blank API key.");
  }
  storage.setItem(API_KEY_STORAGE_KEY, trimmed);
}

export function clearApiKey(storage: StorageLike): void {
  storage.removeItem(API_KEY_STORAGE_KEY);
}
