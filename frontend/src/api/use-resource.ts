import { useCallback, useEffect, useState } from "react";

import { asAdminApiError, type AdminApiError } from "./errors";

/**
 * One request, its lifecycle, and a way to ask again.
 *
 * Two decisions worth keeping:
 *
 * - **A failed load clears the data.** Leaving the previous rows on screen
 *   under an error banner is friendlier and dishonest: this surface exists to
 *   be believed, and stale rows that look current are exactly the failure it
 *   is meant to catch elsewhere in the system.
 * - **A superseded load is ignored, not raced.** The effect aborts and drops
 *   its result on cleanup, so a fast second request cannot be overwritten by
 *   a slow first one.
 *
 * `load` must be stable — wrap it in `useCallback`. It takes the abort signal
 * so the request is actually cancelled rather than merely ignored.
 */
export type Loader<T> = (signal: AbortSignal) => Promise<T>;

export interface Resource<T> {
  readonly data: T | null;
  readonly error: AdminApiError | null;
  readonly loading: boolean;
  /** Ask again. Safe to call while a request is in flight. */
  reload(): void;
}

interface State<T> {
  readonly data: T | null;
  readonly error: AdminApiError | null;
  readonly loading: boolean;
}

export function useResource<T>(load: Loader<T> | null): Resource<T> {
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    loading: load !== null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (load === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    const controller = new AbortController();
    let live = true;
    // Keep whatever is on screen while a reload is in flight; only a failure
    // clears it.
    setState((previous) => ({ ...previous, loading: true }));

    load(controller.signal).then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (cause: unknown) => {
        if (live) setState({ data: null, error: asAdminApiError(cause), loading: false });
      },
    );

    return () => {
      live = false;
      controller.abort();
    };
  }, [load, nonce]);

  const reload = useCallback(() => {
    setNonce((previous) => previous + 1);
  }, []);

  return { ...state, reload };
}
