/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminApiError } from "../../src/api/errors";
import type { MemoryClient } from "../../src/features/memory/memory-client";
import type { MemoryFeedbackResult } from "../../src/features/memory/memory-model";
import { useEdgeVerdict } from "../../src/features/memory/use-memory";

/**
 * The verdict hook — the write half of the correction surface.
 *
 * Its whole job is to make a judgement about ONE connection legible while it is
 * in flight and after it fails. A page-level "saving…" would be useless here:
 * the Commander is going down a list deciding which guesses are wrong, and the
 * feedback has to land on the row he clicked.
 *
 * The failure case is the one that matters most. A rejection he thought he made
 * and a rejection that did not land must never look alike — Syl goes on
 * believing the thing he killed, and nothing else on the page would say so.
 */

function result(overrides: Partial<MemoryFeedbackResult> = {}): MemoryFeedbackResult {
  return {
    verdict: "reject",
    weightBefore: 0.8,
    weightAfter: 0.016,
    surfacedRecorded: 1,
    edge: {
      id: "edge-1",
      kind: "inferred",
      tier: "suppressed",
      sourceNode: "a",
      targetNode: "b",
      relation: "relates_to",
      storedWeight: 0.016,
      effectiveWeight: 0.016,
      confidence: 0.7,
      reasoning: "Both slipped the same week.",
      assertedBy: null,
      demoteAfter: null,
      lastTouchedAt: "2026-08-10T02:00:00.000Z",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-10T02:00:00.000Z",
      origin: "hot_region",
    },
    ...overrides,
  };
}

/** A client whose `judge` a test drives. Reads are never exercised here. */
function stubClient(judge: MemoryClient["judge"]): MemoryClient {
  return {
    graph: () => Promise.reject(new Error("not used")),
    metrics: () => Promise.reject(new Error("not used")),
    judge,
  };
}

describe("useEdgeVerdict", () => {
  it("should start idle, with nothing in flight and nothing to report", () => {
    const { result: hook } = renderHook(() =>
      useEdgeVerdict(stubClient(() => Promise.resolve(result()))),
    );

    expect(hook.current.pendingEdgeId).toBeNull();
    expect(hook.current.error).toBeNull();
    expect(hook.current.failedEdgeId).toBeNull();
    expect(hook.current.last).toBeNull();
  });

  it("should name the edge in flight, so the spinner lands on the row he clicked", async () => {
    let release: ((value: MemoryFeedbackResult) => void) | undefined;
    const judge = vi.fn(
      () =>
        new Promise<MemoryFeedbackResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result: hook } = renderHook(() => useEdgeVerdict(stubClient(judge)));

    act(() => {
      void hook.current.judge("edge-1", "reject");
    });

    await waitFor(() => expect(hook.current.pendingEdgeId).toBe("edge-1"));

    await act(async () => {
      release?.(result());
      await Promise.resolve();
    });

    expect(hook.current.pendingEdgeId).toBeNull();
    expect(hook.current.last?.verdict).toBe("reject");
    expect(hook.current.last?.surfacedRecorded).toBe(1);
  });

  it("should send the verdict the caller asked for, and no other", async () => {
    const judge = vi.fn(() => Promise.resolve(result({ verdict: "confirm" })));
    const { result: hook } = renderHook(() => useEdgeVerdict(stubClient(judge)));

    await act(async () => {
      await hook.current.judge("edge-9", "confirm");
    });

    expect(judge).toHaveBeenCalledWith("edge-9", "confirm");
  });

  it("should keep a failed verdict attached to its edge and NOT report success", async () => {
    // The load-bearing case. A lost rejection means Syl still believes the
    // thing he killed, and no other part of the page would say so.
    const judge = vi.fn(() =>
      Promise.reject(
        new AdminApiError({ kind: "network", retryable: true, message: "the tunnel is down" }),
      ),
    );
    const { result: hook } = renderHook(() => useEdgeVerdict(stubClient(judge)));

    await act(async () => {
      await hook.current.judge("edge-1", "reject");
    });

    expect(hook.current.error?.kind).toBe("network");
    expect(hook.current.failedEdgeId).toBe("edge-1");
    expect(hook.current.last).toBeNull();
    expect(hook.current.pendingEdgeId).toBeNull();
  });

  it("should clear a previous failure when the next verdict is sent", async () => {
    const judge = vi
      .fn<MemoryClient["judge"]>()
      .mockRejectedValueOnce(
        new AdminApiError({ kind: "network", retryable: true, message: "down" }),
      )
      .mockResolvedValueOnce(result());
    const { result: hook } = renderHook(() => useEdgeVerdict(stubClient(judge)));

    await act(async () => {
      await hook.current.judge("edge-1", "reject");
    });
    expect(hook.current.error).not.toBeNull();

    await act(async () => {
      await hook.current.judge("edge-1", "reject");
    });

    expect(hook.current.error).toBeNull();
    expect(hook.current.failedEdgeId).toBeNull();
  });

  it("should reload the view once a verdict lands, because the tier just changed", async () => {
    // A suppression moves the edge out of every scan. A picture that went on
    // drawing it as live would be lying about the one thing this view is for.
    const onSettled = vi.fn();
    const { result: hook } = renderHook(() =>
      useEdgeVerdict(stubClient(() => Promise.resolve(result())), { onSettled }),
    );

    await act(async () => {
      await hook.current.judge("edge-1", "reject");
    });

    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("should report a signed-out click rather than throwing into the console", async () => {
    const { result: hook } = renderHook(() => useEdgeVerdict(null));

    await act(async () => {
      await hook.current.judge("edge-1", "reject");
    });

    expect(hook.current.error?.message).toContain("not sent");
    expect(hook.current.failedEdgeId).toBe("edge-1");
  });
});
