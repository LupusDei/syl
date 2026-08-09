/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement as h, useEffect, useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtureResponse } from "../helpers/fixtures";


import { useAdminClient } from "../../src/api/use-admin-client";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createMemoryStorage, type StorageLike } from "../../src/storage";

afterEach(cleanup);

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

/** Reports whether a client exists and, if it does, what one call returned. */
function Probe(): ReactElement {
  const client = useAdminClient();
  const [count, setCount] = useState<string>("");

  useEffect(() => {
    if (client === null) return;
    void client.listJobs().then((page) => {
      setCount(String(page.items.length));
    });
  }, [client]);

  return h(
    "div",
    null,
    h("span", { "data-testid": "available" }, String(client !== null)),
    h("span", { "data-testid": "count" }, count),
  );
}

describe("useAdminClient", () => {
  it("should be null while the operator is signed out", () => {
    render(h(AuthProvider, { storage: createMemoryStorage(), children: h(Probe, null) }));
    expect(screen.getByTestId("available").textContent).toBe("false");
  });

  it("should decode a real page through the stored credential", async () => {
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(fixtureResponse("http/jobs.page")),
    );
    vi.stubGlobal("fetch", fetchSpy);
    try {
      render(h(AuthProvider, { storage: signedIn(), children: h(Probe, null) }));

      await waitFor(() => expect(screen.getByTestId("count").textContent).not.toBe(""));
      expect(screen.getByTestId("count").textContent).toBe("4");

      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe("/api/v1/jobs");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-syl-abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
