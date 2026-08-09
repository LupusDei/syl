/**
 * The narrow slice of the Web Storage API this app actually uses, plus a
 * wrapper that cannot throw.
 *
 * `localStorage` is not reliably available: Safari's private mode, a browser
 * with site data disabled, and an embedded webview all throw a `SecurityError`
 * from the *getter* as well as from `setItem`. This surface is a debugging
 * instrument — losing a remembered API key is a nuisance, failing to boot at
 * all is not acceptable. Everything here degrades to memory instead.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A `StorageLike` backed by a Map. Also the fallback when nothing else works. */
export function createMemoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/**
 * Wrap a possibly-hostile storage so no call can throw. Reads that fail report
 * `null`; writes that fail are dropped silently, which is the honest outcome —
 * there is nowhere to put the value and nothing the operator can do about it.
 */
export function safeStorage(source: StorageLike | null | undefined): StorageLike {
  if (source === null || source === undefined) return createMemoryStorage();
  return {
    getItem: (key) => {
      try {
        return source.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        source.setItem(key, value);
      } catch {
        /* no durable storage available; the value lives for this session only */
      }
    },
    removeItem: (key) => {
      try {
        source.removeItem(key);
      } catch {
        /* nothing to remove from, which is the state we wanted anyway */
      }
    },
  };
}

/**
 * The app's default store: `localStorage` when the host provides one, memory
 * otherwise. Reading `globalThis.localStorage` is itself guarded because the
 * property getter can throw.
 */
export function defaultStorage(): StorageLike {
  try {
    // Safe: `Storage` structurally satisfies `StorageLike`. The cast only
    // widens the type to admit `undefined`, which the DOM lib declares as
    // always-present but a non-browser host (or a node-environment test) does
    // not actually provide.
    return safeStorage(globalThis.localStorage as StorageLike | undefined);
  } catch {
    return createMemoryStorage();
  }
}
