/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement as h, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAuthedFetch } from "../../src/api/use-authed-fetch";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { createMemoryStorage, type StorageLike } from "../../src/storage";

afterEach(cleanup);

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

/** Calls the hook's request on mount and reports what came back. */
function Probe({ path }: { path: string }): ReactElement {
  const request = useAuthedFetch();
  return h(
    "div",
    null,
    h("span", { "data-testid": "available" }, String(request !== null)),
    h(
      "button",
      {
        onClick: () => {
          void request?.(path);
        },
      },
      "send",
    ),
  );
}

describe("useAuthedFetch", () => {
  it("should return null while the operator is signed out", () => {
    render(
      h(AuthProvider, { storage: createMemoryStorage(), children: h(Probe, { path: "/jobs" }) }),
    );
    expect(screen.getByTestId("available").textContent).toBe("false");
  });

  it("should return a request function once a key is stored", () => {
    render(h(AuthProvider, { storage: signedIn(), children: h(Probe, { path: "/jobs" }) }));
    expect(screen.getByTestId("available").textContent).toBe("true");
  });

  it("should send the stored key as a bearer header", async () => {
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      render(h(AuthProvider, { storage: signedIn(), children: h(Probe, { path: "/jobs" }) }));
      screen.getByRole("button", { name: "send" }).click();

      await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      const init = fetchSpy.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-syl-abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should sign the operator out when the server rejects the key", async () => {
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const storage = signedIn();
    try {
      render(h(AuthProvider, { storage, children: h(Probe, { path: "/jobs" }) }));
      screen.getByRole("button", { name: "send" }).click();

      await waitFor(() => expect(screen.getByTestId("available").textContent).toBe("false"));
      expect(storage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
