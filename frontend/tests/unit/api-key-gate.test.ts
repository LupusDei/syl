/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiKeyGate } from "../../src/auth/ApiKeyGate";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { createMemoryStorage } from "../../src/storage";
import type { StorageLike } from "../../src/storage";

afterEach(cleanup);

function renderGate(storage: StorageLike): void {
  render(h(AuthProvider, { storage, children: h(ApiKeyGate) }));
}

function connectButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /connect/i }) as HTMLButtonElement;
}

describe("ApiKeyGate", () => {
  it("should render a labelled, masked field for the key", () => {
    renderGate(createMemoryStorage());
    const field = screen.getByLabelText(/api key/i) as HTMLInputElement;
    expect(field.type).toBe("password");
  });

  it("should disable submission until something is typed", () => {
    renderGate(createMemoryStorage());
    expect(connectButton().disabled).toBe(true);
  });

  it("should enable submission once a key is typed", () => {
    renderGate(createMemoryStorage());
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-syl-abc" } });
    expect(connectButton().disabled).toBe(false);
  });

  it("should stay disabled for whitespace alone", () => {
    renderGate(createMemoryStorage());
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "   " } });
    expect(connectButton().disabled).toBe(true);
  });

  it("should store the key when the form is submitted", () => {
    const storage = createMemoryStorage();
    renderGate(storage);

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "  sk-syl-abc  " } });
    fireEvent.submit(screen.getByRole("form", { name: /connect to syl/i }));

    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBe("sk-syl-abc");
  });

  it("should not submit a blank key even if the form is submitted directly", () => {
    const storage = createMemoryStorage();
    renderGate(storage);

    fireEvent.submit(screen.getByRole("form", { name: /connect to syl/i }));

    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBeNull();
  });

  it("should tell the operator which backend the key will be sent to", () => {
    renderGate(createMemoryStorage());
    expect(screen.getByTestId("api-base-url").textContent?.length).toBeGreaterThan(0);
  });
});
