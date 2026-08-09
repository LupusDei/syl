/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeliveryView } from "../../src/features/delivery/DeliveryView";
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

function stubApi(make: () => Response = () => fixtureResponse("http/deliveries.page")) {
  const spy = vi.fn((_url: string) => Promise.resolve(make()));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderOutbox(storage: StorageLike = signedIn()): void {
  render(
    h(AuthProvider, {
      storage,
      children: h(MemoryRouter, { initialEntries: ["/delivery"] }, h(DeliveryView)),
    }),
  );
}

/** The fixture body, rebuilt with the rows a given test needs. */
function pageOf(rows: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({ success: true, data: { items: rows, nextCursor: null, hasMore: false } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fixtureRows(): Record<string, unknown>[] {
  return (fixture("http/deliveries.page") as { data: { items: Record<string, unknown>[] } }).data
    .items;
}

describe("DeliveryView", () => {
  it("should default to the unacknowledged view the contract calls interesting", async () => {
    const spy = stubApi();
    renderOutbox();

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(String(spy.mock.calls[0]?.[0])).toContain("unacknowledged=true");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("should say which filter is in force, so an empty table is never misread", async () => {
    stubApi();
    renderOutbox();

    await waitFor(() => expect(screen.getByText(/showing unacknowledged rows only/)).toBeTruthy());
  });

  it("should lead with the unconfirmed count before any row is read", async () => {
    stubApi();
    renderOutbox();

    const banner = await screen.findByTestId("outbox-summary");
    expect(banner.textContent).toContain("have not been acknowledged");
    expect(banner.textContent).toContain("1 awaiting ack");
    expect(banner.textContent).toContain("1 in flight");
  });

  it("should never describe an unacknowledged row as delivered", async () => {
    // `deliveredAt` means APNs accepted the request. Only `ackedAt` means it
    // arrived, and a surface that blurs the two shows a green screen for a
    // night the Commander never heard about.
    stubApi();
    renderOutbox();

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    const unconfirmed = rows.filter((row) => row.textContent?.includes("unconfirmed"));

    expect(unconfirmed.length).toBe(1);
    expect(unconfirmed[0]?.textContent).toContain("never");
  });

  it("should say how long each unconfirmed row has been waiting", async () => {
    stubApi();
    renderOutbox();

    await waitFor(() => expect(screen.getAllByTestId("waiting-for").length).toBe(2));
  });

  it("should show what a coalesced row stands for", async () => {
    // Apple keeps only the most recent notification per app while a device is
    // offline, which is why coalescing exists — one ack covers three
    // commitments, and the count is how you know that.
    stubApi();
    renderOutbox();

    await waitFor(() => expect(screen.getByText("covers 3 reminders")).toBeTruthy());
  });

  it("should surface the retry state of a row that is still being attempted", async () => {
    stubApi();
    renderOutbox();

    await waitFor(() =>
      expect(screen.getByText(/APNs 503 ServiceUnavailable/)).toBeTruthy(),
    );
    expect(screen.getByText(/next 2026-08-09 12:08:00Z/)).toBeTruthy();
  });

  it("should shout when a row was abandoned", async () => {
    const rows = fixtureRows();
    const first = rows[0];
    if (first === undefined) throw new Error("expected a fixture row");
    stubApi(() => pageOf([{ ...first, state: "abandoned", ackedAt: null, engagement: null }]));
    renderOutbox();

    const banner = await screen.findByTestId("outbox-summary");
    expect(banner.textContent).toContain("never confirmed and nothing is retrying them");
  });

  it("should drop the filter and ask the server for everything", async () => {
    const spy = stubApi();
    renderOutbox();
    await waitFor(() => expect(spy).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => !url.includes("unacknowledged"))).toBe(true),
    );
    expect(screen.getByText(/showing every row/)).toBeTruthy();
  });

  it("should filter by state through the server", async () => {
    const spy = stubApi();
    renderOutbox();
    await waitFor(() => expect(spy).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "abandoned" } });

    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => url.includes("state=abandoned"))).toBe(true),
    );
  });

  it("should distinguish an empty filter result from an empty outbox", async () => {
    stubApi(() => pageOf([]));
    renderOutbox();

    await waitFor(() => expect(screen.getByText(/Nothing unacknowledged/)).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByText("The outbox is empty.")).toBeTruthy());
  });

  it("should report a failed request rather than showing an empty outbox", async () => {
    // A non-retryable code, so this asserts the reporting rather than sitting
    // through the backoff — `UPSTREAM_UNAVAILABLE` carries a 5s floor and is
    // covered at the client layer instead.
    stubApi(() => fixtureResponse("errors/not_found", 404));
    renderOutbox();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("NOT_FOUND");
    expect(screen.queryByTestId("outbox-summary")).toBeNull();
  });

  it("should render nothing to load while signed out", () => {
    stubApi();
    renderOutbox(createMemoryStorage());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("should show the acknowledgement latency of a confirmed row", async () => {
    stubApi();
    renderOutbox();
    fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => expect(screen.getByText("after 6.7s")).toBeTruthy());
    expect(screen.getByText("opened")).toBeTruthy();
  });
});
