/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryStorage } from "../../src/storage";
import { THEME_STORAGE_KEY, ThemeProvider, useTheme } from "../../src/theme/ThemeProvider";
import { DEFAULT_THEME, THEME_NAMES } from "../../src/theme/tokens";

afterEach(cleanup);

/** Renders the current theme and offers a button that switches to the next one. */
function Probe(): ReactElement {
  const { theme, setTheme, themes } = useTheme();
  const next = THEME_NAMES.find((name) => name !== theme) ?? theme;
  return h(
    "div",
    null,
    h("span", { "data-testid": "theme" }, theme),
    h("span", { "data-testid": "count" }, String(themes.length)),
    h("button", { onClick: () => setTheme(next) }, "switch"),
  );
}

describe("ThemeProvider", () => {
  it("should start on the default theme when storage is empty", () => {
    render(h(ThemeProvider, { storage: createMemoryStorage(), children: h(Probe) }));
    expect(screen.getByTestId("theme").textContent).toBe(DEFAULT_THEME);
  });

  it("should restore a previously chosen theme from storage", () => {
    const other = THEME_NAMES.find((name) => name !== DEFAULT_THEME) as string;
    const storage = createMemoryStorage();
    storage.setItem(THEME_STORAGE_KEY, other);

    render(h(ThemeProvider, { storage, children: h(Probe) }));

    expect(screen.getByTestId("theme").textContent).toBe(other);
  });

  it("should ignore a stored theme that no longer exists", () => {
    const storage = createMemoryStorage();
    storage.setItem(THEME_STORAGE_KEY, "phosphor-crt");

    render(h(ThemeProvider, { storage, children: h(Probe) }));

    expect(screen.getByTestId("theme").textContent).toBe(DEFAULT_THEME);
  });

  it("should stamp data-theme on the target element so CSS can swap the palette", () => {
    const target = document.createElement("div");
    render(h(ThemeProvider, { storage: createMemoryStorage(), target, children: h(Probe) }));
    expect(target.getAttribute("data-theme")).toBe(DEFAULT_THEME);
  });

  it("should stamp color-scheme so native form controls follow the palette", () => {
    const target = document.createElement("div");
    render(h(ThemeProvider, { storage: createMemoryStorage(), target, children: h(Probe) }));
    expect(target.style.colorScheme).toBeTruthy();
  });

  it("should default the target to the document element", () => {
    render(h(ThemeProvider, { storage: createMemoryStorage(), children: h(Probe) }));
    expect(document.documentElement.getAttribute("data-theme")).toBe(DEFAULT_THEME);
  });

  it("should persist and re-stamp when the theme changes", () => {
    const storage = createMemoryStorage();
    const target = document.createElement("div");
    render(h(ThemeProvider, { storage, target, children: h(Probe) }));

    fireEvent.click(screen.getByRole("button", { name: "switch" }));

    const chosen = screen.getByTestId("theme").textContent as string;
    expect(chosen).not.toBe(DEFAULT_THEME);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe(chosen);
    expect(target.getAttribute("data-theme")).toBe(chosen);
  });

  it("should expose the full theme list for a picker", () => {
    render(h(ThemeProvider, { storage: createMemoryStorage(), children: h(Probe) }));
    expect(screen.getByTestId("count").textContent).toBe(String(THEME_NAMES.length));
  });
});

describe("useTheme", () => {
  it("should throw outside a provider rather than silently render unthemed", () => {
    expect(() => render(h(Probe))).toThrow(/ThemeProvider/);
  });
});
