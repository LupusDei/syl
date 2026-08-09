/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../../src/app/App";
import { NAV_ITEMS } from "../../src/app/nav";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { createMemoryStorage } from "../../src/storage";
import type { StorageLike } from "../../src/storage";

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

function authenticatedStorage(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

describe("App", () => {
  it("should show the key gate when no key is stored", () => {
    render(h(App, { storage: createMemoryStorage() }));
    expect(screen.getByLabelText(/api key/i)).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("should show the admin chrome once a key is stored", () => {
    render(h(App, { storage: authenticatedStorage() }));
    expect(screen.getByRole("navigation")).toBeTruthy();
  });

  it("should render a nav link for every registered nav item", () => {
    render(h(App, { storage: authenticatedStorage() }));
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole("link", { name: item.label })).toBeTruthy();
    }
  });

  it("should land on the overview at the root path", () => {
    render(h(App, { storage: authenticatedStorage() }));
    expect(screen.getByRole("heading", { level: 1, name: /overview/i })).toBeTruthy();
  });

  it("should route to a planned view and say which bead owns it", () => {
    render(h(App, { storage: authenticatedStorage() }));
    const planned = NAV_ITEMS.find((item) => item.status === "planned");
    if (!planned) throw new Error("expected at least one planned nav item");

    fireEvent.click(screen.getByRole("link", { name: planned.label }));

    expect(screen.getByRole("heading", { level: 1, name: planned.label })).toBeTruthy();
    expect(screen.getByText(new RegExp(planned.bead))).toBeTruthy();
  });

  it("should show a not-found view for an unknown path", () => {
    window.history.pushState({}, "", "/nowhere");
    render(h(App, { storage: authenticatedStorage() }));
    expect(screen.getByRole("heading", { level: 1, name: /not found/i })).toBeTruthy();
  });

  it("should return to the gate when the key is cleared", () => {
    const storage = authenticatedStorage();
    render(h(App, { storage }));

    fireEvent.click(screen.getByRole("button", { name: /clear key/i }));

    expect(screen.getByLabelText(/api key/i)).toBeTruthy();
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
  });

  it("should let the operator switch palette from the chrome", () => {
    render(h(App, { storage: authenticatedStorage() }));
    const picker = screen.getByLabelText(/palette/i) as HTMLSelectElement;
    const other = [...picker.options].map((option) => option.value).find((v) => v !== picker.value);
    if (!other) throw new Error("expected more than one palette");

    fireEvent.change(picker, { target: { value: other } });

    expect(document.documentElement.getAttribute("data-theme")).toBe(other);
  });

  it("should colour overview status dots from semantic tokens, never literal colours", () => {
    const { container } = render(h(App, { storage: authenticatedStorage() }));
    const dots = [...container.querySelectorAll<HTMLElement>(".status__dot")];

    expect(dots.length).toBe(NAV_ITEMS.length);
    for (const dot of dots) expect(dot.style.background).toMatch(/^var\(--syl-state-/);
  });

  it("should show the API base URL in the chrome, so the target is never ambiguous", () => {
    render(h(App, { storage: authenticatedStorage() }));
    expect(screen.getByTestId("api-base-url").textContent?.length).toBeGreaterThan(0);
  });
});
