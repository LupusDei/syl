/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevicesView } from "../../src/features/devices/DevicesView";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createMemoryStorage, type StorageLike } from "../../src/storage";
import { fixture, fixtureResponse } from "../helpers/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

function stubApi(make: () => Response = () => fixtureResponse("http/devices.page")) {
  const spy = vi.fn((_url: string) => Promise.resolve(make()));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderView(storage: StorageLike = signedIn()): void {
  render(
    h(AuthProvider, {
      storage,
      children: h(MemoryRouter, { initialEntries: ["/devices"] }, h(DevicesView)),
    }),
  );
}

function pageOf(rows: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({ success: true, data: { items: rows, nextCursor: null, hasMore: false } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fixtureRows(): Record<string, unknown>[] {
  return (fixture("http/devices.page") as { data: { items: Record<string, unknown>[] } }).data.items;
}

/**
 * The fixture rows, with the live device seen just now.
 *
 * `DevicesView` decides "active" versus "not seen recently" against the REAL
 * clock, and the fixture's `lastSeenAt` is a fixed instant captured on
 * 2026-08-09. So the badge said "active" on the day this test was written and
 * said "not seen recently" from the following morning onwards, with no change
 * to any code — the same one-day fuse that migration `0001` lit with
 * `strftime('now')` (see `backend/tests/helpers/service.ts`).
 *
 * Anchoring the live row to the moment the test runs keeps the assertion about
 * what it is actually about — an unregistered device reads "unregistered" and a
 * live one reads "active" — rather than about how long ago the fixture was
 * captured. The fixture itself is left alone: it is captured wire output, and
 * the other cases here depend on its instants.
 */
function seenJustNow(): Record<string, unknown>[] {
  return fixtureRows().map((device) =>
    device["active"] === true ? { ...device, lastSeenAt: new Date().toISOString() } : device,
  );
}

describe("DevicesView", () => {
  it("should list every registered target, active first", async () => {
    stubApi();
    renderView();

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.getByText("Commander's iPhone")).toBeTruthy();
    expect(screen.getByText("iPhone (Xcode debug)")).toBeTruthy();
  });

  it("should show the APNs environment of every token", async () => {
    // It is carried per token, never server-wide: a global setting breaks one
    // of them and the only symptom is BadDeviceToken on every send.
    stubApi();
    renderView();

    await waitFor(() => expect(screen.getByText("production")).toBeTruthy());
    expect(screen.getByText("sandbox")).toBeTruthy();
  });

  it("should call out a fleet running both environments at once", async () => {
    stubApi();
    renderView();

    const banner = await screen.findByTestId("fleet-summary");
    expect(banner.textContent).toContain("Both APNs environments");
  });

  it("should say plainly when nothing can be pushed to", async () => {
    const rows = fixtureRows().map((device) => ({ ...device, active: false }));
    stubApi(() => pageOf(rows));
    renderView();

    const banner = await screen.findByTestId("fleet-summary");
    expect(banner.textContent).toContain("Nothing can be pushed to");
  });

  it("should describe an unregistered device as unregistered, not missing", async () => {
    stubApi(() => pageOf(seenJustNow()));
    renderView();

    await waitFor(() => expect(screen.getByText("unregistered")).toBeTruthy());
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("should show only the token suffix, never a whole token", async () => {
    stubApi();
    renderView();

    await waitFor(() => expect(screen.getByText("…9c0d2e41")).toBeTruthy());
  });

  it("should say how long since each device was seen", async () => {
    stubApi();
    renderView();

    await waitFor(() => expect(screen.getAllByText(/ago$/).length).toBe(2));
  });

  it("should report a failed request rather than an empty fleet", async () => {
    stubApi(() => fixtureResponse("errors/not_found", 404));
    renderView();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByTestId("fleet-summary")).toBeNull();
  });

  it("should say when nothing has ever registered", async () => {
    stubApi(() => pageOf([]));
    renderView();

    await waitFor(() => expect(screen.getByText("No device has ever registered.")).toBeTruthy());
  });

  it("should render nothing to load while signed out", () => {
    stubApi();
    renderView(createMemoryStorage());
    expect(screen.queryByRole("table")).toBeNull();
  });
});
