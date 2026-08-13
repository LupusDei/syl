import { useCallback, useEffect, useMemo, useState } from "react";

import { asAdminApiError, type AdminApiError } from "../../api/errors";
import { useAuthedFetch } from "../../api/use-authed-fetch";
import { createHealthClient, type HealthClient, type HealthClientOptions } from "./health-client";
import {
  HEALTH_TYPES,
  type HealthSeries,
  type HealthType,
  type TypeLoad,
  type WindowRange,
} from "./health-model";

/**
 * The hooks the health viewer runs on.
 *
 * `useResource` — which every other viewer here uses — is one request with one
 * lifecycle, and this view is seven. That difference is not a convenience, it is
 * the requirement:
 *
 * - **Each type settles on its own.** Heart rate over sixty days is thousands of
 *   rows and body mass is a handful. One `Promise.all` would hold the whole page
 *   at "loading" behind the slowest type, and — worse — one rejection would take
 *   the other six down with it.
 * - **A failed type is not an empty type.** `useResource` clears its data on
 *   failure, which is right for a table and catastrophic here: a request that did
 *   not come back would render as a type with no samples, which is the exact
 *   conflation this feature exists to abolish, arriving through the front door.
 *   So the failure is kept per type, named, and rendered as its own thing.
 * - **A superseded window is dropped, not raced.** Changing the window while
 *   heart rate is still in flight must not let the old answer land under the new
 *   heading.
 */

/** The typed health client, wired to the stored key. `null` when signed out. */
export function useHealthClient(options: Omit<HealthClientOptions, "request"> = {}): HealthClient | null {
  const request = useAuthedFetch();
  const { policy, sleep, random } = options;
  return useMemo(
    () =>
      request === null
        ? null
        : createHealthClient({
            request,
            ...(policy === undefined ? {} : { policy }),
            ...(sleep === undefined ? {} : { sleep }),
            ...(random === undefined ? {} : { random }),
          }),
    [request, policy, sleep, random],
  );
}

/** One type's slot in the window. */
export interface TypeState {
  readonly type: HealthType;
  /** Still in flight. Distinct from both "empty" and "failed". */
  readonly pending: boolean;
  readonly series: HealthSeries | null;
  readonly error: AdminApiError | null;
}

export interface HealthWindow {
  /** At least one type is still in flight. */
  readonly loading: boolean;
  readonly types: readonly TypeState[];
  /** No credential — nothing was asked at all. */
  readonly signedOut: boolean;
  /** Ask again for every type. Safe while requests are in flight. */
  reload(): void;
}

function idle(types: readonly HealthType[], pending: boolean): readonly TypeState[] {
  return types.map((type) => ({ type, pending, series: null, error: null }));
}

/**
 * What the model needs from a settled slot.
 *
 * `pending` is deliberately NOT folded into `TypeLoad`: `readingOf` answers
 * "what does this empty panel mean", and "we have not asked yet" is a question
 * for the view's loading state rather than an answer about his body.
 */
export function asLoad(state: TypeState): TypeLoad {
  return { type: state.type, series: state.series, failed: state.error !== null };
}

export interface HealthWindowOptions {
  /** Defaults to all seven. Injectable so a test can drive one type. */
  readonly types?: readonly HealthType[] | undefined;
}

/**
 * Seven series for one window.
 *
 * **`client` must be stable across renders** — `useHealthClient` memoises it,
 * and `useResource` makes the same demand of its `load`. A client rebuilt on
 * every render re-runs the effect on every render, and because this effect sets
 * state, that is not a wasted fetch but an unbounded loop. It cost a
 * sixty-five-second out-of-memory test run to find.
 */
export function useHealthWindow(
  client: HealthClient | null,
  range: WindowRange,
  options: HealthWindowOptions = {},
): HealthWindow {
  const types = options.types ?? HEALTH_TYPES;
  const [states, setStates] = useState<readonly TypeState[]>(() => idle(types, client !== null));
  const [nonce, setNonce] = useState(0);

  // The window is two strings, and the object holding them is rebuilt on every
  // render. Keying the effect on the object would re-fetch seven series on
  // every keystroke elsewhere in the tree; keying on the strings fetches when
  // the window actually moves.
  const { from, to } = range;
  const key = types.join(",");

  useEffect(() => {
    if (client === null) {
      setStates(idle(types, false));
      return;
    }

    const controller = new AbortController();
    let live = true;
    setStates(idle(types, true));

    for (const type of types) {
      client.series({ type, from, to }, { signal: controller.signal }).then(
        (series) => {
          if (!live) return;
          setStates((previous) =>
            previous.map((state) =>
              state.type === type ? { type, pending: false, series, error: null } : state,
            ),
          );
        },
        (cause: unknown) => {
          if (!live) return;
          setStates((previous) =>
            previous.map((state) =>
              state.type === type
                ? { type, pending: false, series: null, error: asAdminApiError(cause) }
                : state,
            ),
          );
        },
      );
    }

    return () => {
      live = false;
      controller.abort();
    };
    // `types` is covered by `key`; listing the array itself would re-run on
    // every render for a caller that builds it inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, from, to, key, nonce]);

  const reload = useCallback(() => {
    setNonce((previous) => previous + 1);
  }, []);

  return {
    loading: states.some((state) => state.pending),
    types: states,
    signedOut: client === null,
    reload,
  };
}
