/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement as h, useCallback, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { malformedResponse } from "../../src/api/errors";
import { useResource, type Loader } from "../../src/api/use-resource";

afterEach(cleanup);

/** Renders the whole resource state, so every assertion reads off the DOM. */
function Probe({ load }: { load: Loader<string> | null }): ReactElement {
  const stable = useCallback<Loader<string>>(
    (signal) => (load === null ? Promise.reject(new Error("unreachable")) : load(signal)),
    [load],
  );
  const resource = useResource<string>(load === null ? null : stable);

  return h(
    "div",
    null,
    h("span", { "data-testid": "data" }, resource.data ?? ""),
    h("span", { "data-testid": "error" }, resource.error?.kind ?? ""),
    h("span", { "data-testid": "loading" }, String(resource.loading)),
    h("button", { onClick: resource.reload }, "reload"),
  );
}

/** A promise the test resolves by hand, so loading states can be observed. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useResource", () => {
  it("should report not-loading and no data when there is nothing to load", () => {
    render(h(Probe, { load: null }));
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("data").textContent).toBe("");
  });

  it("should load, then hold the result", async () => {
    render(h(Probe, { load: () => Promise.resolve("rows") }));
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("rows"));
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("should be loading before the first result arrives", async () => {
    const gate = deferred<string>();
    render(h(Probe, { load: () => gate.promise }));

    expect(screen.getByTestId("loading").textContent).toBe("true");
    await act(async () => {
      gate.resolve("rows");
      await gate.promise;
    });
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("should surface a failure in the taxonomy and clear the stale data", async () => {
    // Stale rows that look current are exactly the failure this surface
    // exists to catch elsewhere; it must not commit it itself.
    render(h(Probe, { load: () => Promise.reject(malformedResponse(502, "gateway")) }));

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("malformed"));
    expect(screen.getByTestId("data").textContent).toBe("");
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("should normalise a throw that is not one of ours", async () => {
    render(h(Probe, { load: () => Promise.reject(new RangeError("off the end")) }));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("unknown"));
  });

  it("should ask again on reload", async () => {
    const load = vi
      .fn<Loader<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    render(h(Probe, { load }));
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("first"));

    act(() => {
      screen.getByRole("button", { name: "reload" }).click();
    });
    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("second"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("should abort the in-flight request when it is superseded", async () => {
    const seen: AbortSignal[] = [];
    const load = vi.fn<Loader<string>>((signal) => {
      seen.push(signal);
      return seen.length === 1 ? new Promise<string>(() => undefined) : Promise.resolve("second");
    });

    render(h(Probe, { load }));
    act(() => {
      screen.getByRole("button", { name: "reload" }).click();
    });

    await waitFor(() => expect(screen.getByTestId("data").textContent).toBe("second"));
    expect(seen[0]?.aborted).toBe(true);
  });

  it("should ignore a result that arrives after unmount", async () => {
    // A `setState` on an unmounted tree warns on the console; asserting that
    // nothing was logged is the only observable proof the guard holds.
    const complaints = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gate = deferred<string>();
    const view = render(h(Probe, { load: () => gate.promise }));
    view.unmount();

    await act(async () => {
      gate.resolve("late");
      await gate.promise;
    });

    expect(complaints).not.toHaveBeenCalled();
    complaints.mockRestore();
  });

  it("should ignore a failure that arrives after unmount", async () => {
    const complaints = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const gate = deferred<string>();
    const view = render(h(Probe, { load: () => gate.promise }));
    view.unmount();

    await act(async () => {
      gate.reject(malformedResponse(500, "late"));
      await gate.promise.catch(() => undefined);
    });

    expect(complaints).not.toHaveBeenCalled();
    complaints.mockRestore();
  });
});
