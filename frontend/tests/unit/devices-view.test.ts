/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevicesView } from "../../src/features/devices/DevicesView";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createMemoryStorage, type StorageLike } from "../../src/storage";
import { fixture, fixtureResponse } from "../helpers/fixtures";

/**
 * An hour after the newest `lastSeenAt` in `http/devices.page`.
 *
 * Fixed, because "active" is a statement about how long ago a device was last
 * heard from and every fixture instant is in the past — so a view test read on
 * the real clock is a test whose answer changes with the day it is run.
 */
const JUST_AFTER_THE_FIXTURE = new Date("2026-08-09T07:58:00.000Z");

beforeEach(() => {
  // `Date` only. Faking `setTimeout` would stop `waitFor` making progress and
  // every assertion in this file would time out instead.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(JUST_AFTER_THE_FIXTURE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
      // Pinned to the fixture, never to the wall clock — see fixtureNow().
      children: h(MemoryRouter, { initialEntries: ["/devices"] }, h(DevicesView, { now: fixtureNow() })),
    }),
  );
}

function pageOf(rows: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({ success: true, data: { items: rows, nextCursor: null, hasMore: false } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A moment pinned to the FIXTURE, not to the wall clock.
 *
 * `standingOf` calls a device stale after 24 hours of silence, and the fixture's
 * timestamps are absolute. Rendering against the real clock meant these
 * assertions aged out: the healthy device turned stale a day after the fixture
 * was written and "active" stopped appearing, which reads as a regression in the
 * view and is not one.
 *
 * Derived from the newest `lastSeenAt` in the fixture, so it stays correct if the
 * fixture is regenerated — a hard-coded instant here would simply move the bomb.
 */
function fixtureNow(): Date {
  const newest = fixtureRows()
    .map((device) => Date.parse(String(device["lastSeenAt"])))
    .filter((value) => !Number.isNaN(value))
    .reduce((a, b) => Math.max(a, b), 0);
  return new Date(newest + 60_000);
}

function fixtureRows(): Record<string, unknown>[] {
  return (fixture("http/devices.page") as { data: { items: Record<string, unknown>[] } }).data.items;
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
    // The clock is frozen an hour after the fixture's newest `lastSeenAt`, and
    // that is the whole reason this test has a `beforeEach` at all. `active`
    // means "registered and heard from within a day" — so on the real clock
    // this assertion was true on the day the fixture was captured and has been
    // false ever since, which is the one-day-fuse time bomb the backend suite
    // documents, wearing a frontend hat. Only `Date` is faked: `waitFor` needs
    // real timers to make progress.
    stubApi();
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
