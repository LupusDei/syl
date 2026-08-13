/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminApiError } from "../../src/api/errors";
import type { HealthClient } from "../../src/features/health/health-client";
import type { HealthSeries, HealthType } from "../../src/features/health/health-model";
import { asLoad, useHealthWindow } from "../../src/features/health/use-health";

/**
 * The window hook.
 *
 * `useResource` — the one every other viewer uses — is one request with one
 * lifecycle, and this view is seven. The difference is the requirement, not a
 * convenience:
 *
 * - one slow type must not hold the other six at "loading";
 * - one FAILED type must not render as an EMPTY type, which is the exact
 *   conflation this feature exists to abolish arriving through the front door;
 * - a superseded window must not land under the new heading.
 */

const RANGE = { from: "2026-08-12T00:00:00.000Z", to: "2026-08-13T00:00:00.000Z" };
const TWO: readonly HealthType[] = ["steps", "heartRate"];

function series(type: HealthType, overrides: Partial<HealthSeries> = {}): HealthSeries {
  return {
    type,
    unit: "count",
    state: "authorised",
    reportedAt: "2026-08-13T06:00:00.000Z",
    silenceIsEvidence: true,
    watermark: null,
    samples: [],
    ...overrides,
  };
}

/**
 * A client whose answer per type a test controls.
 *
 * **Built once per test, never inside the render callback.** The hook keys its
 * effect on the client identity, exactly as `useResource` keys on `load`, so a
 * client rebuilt every render re-fetches every render — which in a hook that
 * also sets state on fetch is an infinite loop. It cost a 65-second
 * out-of-memory run to find, and `useHealthClient` memoises for the same
 * reason.
 */
function stubClient(answer: HealthClient["series"]): HealthClient {
  return { series: answer };
}

function stateFor(hook: { current: ReturnType<typeof useHealthWindow> }, type: HealthType) {
  const found = hook.current.types.find((candidate) => candidate.type === type);
  if (found === undefined) throw new Error(`no slot for ${type}`);
  return found;
}

describe("useHealthWindow", () => {
  it("should start with every type pending and nothing decided", () => {
    const client = stubClient(() => new Promise<HealthSeries>(() => {}));
    const { result } = renderHook(() => useHealthWindow(client, RANGE, { types: TWO }));

    expect(result.current.loading).toBe(true);
    expect(result.current.signedOut).toBe(false);
    expect(result.current.types.length).toBe(2);
    for (const state of result.current.types) {
      expect(state.pending).toBe(true);
      expect(state.series).toBeNull();
      expect(state.error).toBeNull();
    }
  });

  it("should settle each type on its own, without waiting for the slowest", async () => {
    // A `Promise.all` here would hold heart rate's answer behind sixty days of
    // steps, and the page would sit at "loading" with data already in hand.
    let releaseSlow: ((value: HealthSeries) => void) | undefined;
    const client = stubClient((params) =>
      params.type === "steps"
        ? Promise.resolve(series("steps"))
        : new Promise<HealthSeries>((resolve) => {
            releaseSlow = resolve;
          }),
    );
    const { result } = renderHook(() => useHealthWindow(client, RANGE, { types: TWO }));

    await waitFor(() => expect(stateFor(result, "steps").pending).toBe(false));
    expect(stateFor(result, "heartRate").pending).toBe(true);
    expect(result.current.loading).toBe(true);

    await act(async () => {
      releaseSlow?.(series("heartRate"));
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
  });

  it("should keep a FAILED type failed, and never as a type with no samples", async () => {
    // The load-bearing case. `useResource` clears its data on failure, which is
    // right for a table and catastrophic here: an unanswered request would look
    // exactly like an authorised type with a quiet day.
    const client = stubClient((params) =>
      params.type === "steps"
        ? Promise.reject(
            new AdminApiError({ kind: "network", retryable: true, message: "the tunnel is down" }),
          )
        : Promise.resolve(series("heartRate")),
    );
    const { result } = renderHook(() => useHealthWindow(client, RANGE, { types: TWO }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    const failed = stateFor(result, "steps");
    expect(failed.error?.kind).toBe("network");
    expect(failed.series).toBeNull();
    expect(asLoad(failed).failed).toBe(true);

    // And it took nothing else down with it.
    expect(stateFor(result, "heartRate").series?.type).toBe("heartRate");
    expect(stateFor(result, "heartRate").error).toBeNull();
  });

  it("should normalise a thrown non-error into the failure taxonomy", async () => {
    const client = stubClient(() => Promise.reject("something odd"));
    const { result } = renderHook(() => useHealthWindow(client, RANGE, { types: ["steps"] }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(stateFor(result, "steps").error).toBeInstanceOf(AdminApiError);
    expect(stateFor(result, "steps").error?.kind).toBe("unknown");
  });

  it("should ask again for every type when told to reload", async () => {
    const answer = vi.fn((params: { type: HealthType }) => Promise.resolve(series(params.type)));
    const client = stubClient(answer);
    const { result } = renderHook(() => useHealthWindow(client, RANGE, { types: TWO }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(answer).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(4));
  });

  it("should re-ask when the window moves, and not when the range object is merely rebuilt", async () => {
    const answer = vi.fn((params: { type: HealthType }) => Promise.resolve(series(params.type)));
    const client = stubClient(answer);
    const { result, rerender } = renderHook(
      ({ range }: { range: { from: string; to: string } }) =>
        useHealthWindow(client, range, { types: ["steps"] }),
      { initialProps: { range: RANGE } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(answer).toHaveBeenCalledTimes(1);

    // Same window, new object — the shape a render produces every time.
    rerender({ range: { from: RANGE.from, to: RANGE.to } });
    expect(answer).toHaveBeenCalledTimes(1);

    rerender({ range: { from: "2026-08-01T00:00:00.000Z", to: RANGE.to } });
    await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
  });

  it("should ask nothing at all when signed out, and say so", () => {
    const answer = vi.fn(() => Promise.resolve(series("steps")));
    const { result } = renderHook(() => useHealthWindow(null, RANGE, { types: TWO }));

    expect(answer).not.toHaveBeenCalled();
    expect(result.current.signedOut).toBe(true);
    expect(result.current.loading).toBe(false);
    for (const state of result.current.types) {
      expect(state.pending).toBe(false);
    }
  });

  it("should drop an answer that arrives after its window was superseded", async () => {
    let releaseOld: ((value: HealthSeries) => void) | undefined;
    let calls = 0;
    const client = stubClient(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<HealthSeries>((resolve) => {
          releaseOld = resolve;
        });
      }
      return Promise.resolve(series("steps", { unit: "new-window" }));
    });

    const { result, rerender } = renderHook(
      ({ range }: { range: { from: string; to: string } }) =>
        useHealthWindow(client, range, { types: ["steps"] }),
      { initialProps: { range: RANGE } },
    );

    rerender({ range: { from: "2026-07-01T00:00:00.000Z", to: RANGE.to } });
    await waitFor(() => expect(stateFor(result, "steps").series?.unit).toBe("new-window"));

    await act(async () => {
      releaseOld?.(series("steps", { unit: "stale" }));
      await Promise.resolve();
    });

    // The stale answer must not have landed under the new heading.
    expect(stateFor(result, "steps").series?.unit).toBe("new-window");
  });
});

describe("asLoad", () => {
  it("should hand the model a settled slot without the pending flag", () => {
    // `readingOf` answers "what does this empty panel mean about him". "We have
    // not asked yet" is not an answer to that question, so it is deliberately
    // not part of the shape the model sees.
    const load = asLoad({ type: "steps", pending: false, series: series("steps"), error: null });
    expect(load).toEqual({ type: "steps", series: series("steps"), failed: false });
  });
});
