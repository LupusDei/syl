import { useCallback, useMemo, useState } from "react";

import { asAdminApiError, type AdminApiError } from "../../api/errors";
import { useAuthedFetch } from "../../api/use-authed-fetch";
import { createMemoryClient, type MemoryClient, type MemoryClientOptions } from "./memory-client";
import type { MemoryFeedbackResult, Verdict } from "./memory-model";

/**
 * The hooks the memory viewer runs on.
 *
 * Reads go through `useResource`, which every other viewer here uses. The
 * *write* needed its own hook, and the shape of it is the interesting part:
 *
 * - **One edge at a time is in flight, and the view knows which one.** The
 *   verdict is a judgement about a specific connection, so "saving…" has to
 *   attach to the row he clicked rather than to the page. `pendingEdgeId` is
 *   what makes a disabled button and a spinner land in the right place.
 * - **A failed verdict is loud and does not clear the row.** The reject he
 *   thought he made and the reject that did not land must not look alike; that
 *   is the same instrument principle `ui/feedback.tsx` states for reads, and it
 *   matters more here because a lost rejection means Syl goes on believing
 *   something he has already killed.
 * - **Success reports what actually happened.** `surfacedRecorded` and the
 *   before/after weights come back from the server rather than being assumed,
 *   because the weight law is not a thing this layer should be re-deriving.
 */

/** The typed memory client, wired to the stored key. `null` when signed out. */
export function useMemoryClient(options: Omit<MemoryClientOptions, "request"> = {}): MemoryClient | null {
  const request = useAuthedFetch();
  const { newKey, policy, sleep, random } = options;
  return useMemo(
    () =>
      request === null
        ? null
        : createMemoryClient({
            request,
            ...(newKey === undefined ? {} : { newKey }),
            ...(policy === undefined ? {} : { policy }),
            ...(sleep === undefined ? {} : { sleep }),
            ...(random === undefined ? {} : { random }),
          }),
    [request, newKey, policy, sleep, random],
  );
}

export interface EdgeVerdict {
  /** The edge a verdict is in flight for, or `null`. */
  readonly pendingEdgeId: string | null;
  /** The last failure. Cleared when the next verdict is sent. */
  readonly error: AdminApiError | null;
  /** The edge the last failure was about, so the row can carry it. */
  readonly failedEdgeId: string | null;
  /** What the last successful verdict did. */
  readonly last: MemoryFeedbackResult | null;
  /** Send a verdict. Resolves when it has landed or failed; never throws. */
  judge(edgeId: string, verdict: Verdict): Promise<void>;
}

export interface EdgeVerdictOptions {
  /**
   * Called after a verdict lands. The view uses it to reload the graph, because
   * a suppression changes the tier of the edge and the shape of the picture.
   */
  readonly onSettled?: (() => void) | undefined;
}

interface VerdictState {
  readonly pendingEdgeId: string | null;
  readonly error: AdminApiError | null;
  readonly failedEdgeId: string | null;
  readonly last: MemoryFeedbackResult | null;
}

const IDLE: VerdictState = {
  pendingEdgeId: null,
  error: null,
  failedEdgeId: null,
  last: null,
};

export function useEdgeVerdict(
  client: MemoryClient | null,
  options: EdgeVerdictOptions = {},
): EdgeVerdict {
  const [state, setState] = useState<VerdictState>(IDLE);
  const { onSettled } = options;

  const judge = useCallback(
    async (edgeId: string, verdict: Verdict): Promise<void> => {
      if (client === null) {
        // Reachable only from outside the gate. Reported rather than thrown:
        // a correction surface that throws on a click leaves the operator with
        // a console message he will not read.
        setState({
          pendingEdgeId: null,
          failedEdgeId: edgeId,
          last: null,
          error: asAdminApiError(new Error("Signed out — the verdict was not sent.")),
        });
        return;
      }

      setState((previous) => ({
        pendingEdgeId: edgeId,
        error: null,
        failedEdgeId: null,
        last: previous.last,
      }));

      try {
        const result = await client.judge(edgeId, verdict);
        setState({ pendingEdgeId: null, error: null, failedEdgeId: null, last: result });
        onSettled?.();
      } catch (cause: unknown) {
        setState({
          pendingEdgeId: null,
          error: asAdminApiError(cause),
          failedEdgeId: edgeId,
          last: null,
        });
      }
    },
    [client, onSettled],
  );

  return { ...state, judge };
}
