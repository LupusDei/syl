/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { createMemoryStorage } from "../../src/storage";

afterEach(cleanup);

function Probe(): ReactElement {
  const { apiKey, isAuthenticated, signIn, signOut } = useAuth();
  return h(
    "div",
    null,
    h("span", { "data-testid": "key" }, apiKey ?? "none"),
    h("span", { "data-testid": "authed" }, String(isAuthenticated)),
    h("button", { onClick: () => signIn(" sk-syl-typed ") }, "sign in"),
    h("button", { onClick: () => signOut() }, "sign out"),
  );
}

describe("AuthProvider", () => {
  it("should start unauthenticated when no key is stored", () => {
    render(h(AuthProvider, { storage: createMemoryStorage(), children: h(Probe) }));
    expect(screen.getByTestId("authed").textContent).toBe("false");
    expect(screen.getByTestId("key").textContent).toBe("none");
  });

  it("should start authenticated when a key is already stored", () => {
    const storage = createMemoryStorage();
    storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-stored");

    render(h(AuthProvider, { storage, children: h(Probe) }));

    expect(screen.getByTestId("authed").textContent).toBe("true");
    expect(screen.getByTestId("key").textContent).toBe("sk-syl-stored");
  });

  it("should persist a trimmed key on sign in", () => {
    const storage = createMemoryStorage();
    render(h(AuthProvider, { storage, children: h(Probe) }));

    fireEvent.click(screen.getByRole("button", { name: "sign in" }));

    expect(screen.getByTestId("key").textContent).toBe("sk-syl-typed");
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBe("sk-syl-typed");
  });

  it("should clear the stored key on sign out", () => {
    const storage = createMemoryStorage();
    storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-stored");
    render(h(AuthProvider, { storage, children: h(Probe) }));

    fireEvent.click(screen.getByRole("button", { name: "sign out" }));

    expect(screen.getByTestId("authed").textContent).toBe("false");
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
  });

  it("should ignore a blank sign in rather than store an unusable credential", () => {
    const storage = createMemoryStorage();

    function BlankProbe(): ReactElement {
      const { signIn, isAuthenticated } = useAuth();
      return h(
        "div",
        null,
        h("span", { "data-testid": "authed" }, String(isAuthenticated)),
        h("button", { onClick: () => signIn("   ") }, "blank"),
      );
    }

    render(h(AuthProvider, { storage, children: h(BlankProbe) }));
    fireEvent.click(screen.getByRole("button", { name: "blank" }));

    expect(screen.getByTestId("authed").textContent).toBe("false");
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
  });
});

describe("useAuth", () => {
  it("should throw outside a provider rather than render a half-authenticated tree", () => {
    expect(() => render(h(Probe))).toThrow(/AuthProvider/);
  });
});
