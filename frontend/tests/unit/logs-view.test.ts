/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogEntry } from "@syl/shared/types";

import { LogsView } from "../../src/features/logs/LogsView";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createMemoryStorage, type StorageLike } from "../../src/storage";

/**
 * The logs view, driven through the network boundary.
 *
 * There is deliberately no shared fixture for a log page: the manifest is
 * decoded by the Swift contract suite too, and `GET /logs` is the one endpoint
 * the phone is forbidden to call, so adding one would oblige SylKit to model
 * it. The payloads here are built to the contract's `LogPage` instead.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "syl_pat_0123456789abcdef0123456789abcdef");
  return storage;
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2026-08-10T13:04:00.000Z",
    level: "info",
    event: "turn.tool",
    pid: 4242,
    fields: { tool: "Bash" },
    ...overrides,
  };
}

const PAGE: readonly LogEntry[] = [
  entry({ ts: "2026-08-10T13:06:00.000Z", fields: { tool: "Bash" } }),
  entry({ ts: "2026-08-10T13:05:00.000Z", fields: { tool: "Read" } }),
  entry({ ts: "2026-08-10T13:04:00.000Z", fields: { tool: "Bash" } }),
  entry({
    ts: "2026-08-10T13:03:00.000Z",
    event: "turn.start",
    fields: { sessionId: "0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f" },
  }),
  entry({
    ts: "2026-08-10T13:02:00.000Z",
    level: "error",
    event: "turn.api_error",
    fields: { message: "upstream connection reset" },
  }),
];

function okPage(items: readonly LogEntry[] = PAGE, hasMore = false): Response {
  return new Response(
    JSON.stringify({ success: true, data: { items, nextCursor: null, hasMore } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function forbidden(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "FORBIDDEN",
        message:
          "This endpoint needs a key with admin scope. Paired devices do not get one — mint it at the machine's own console with `npm run pair -- --admin`.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

/** The network, faked. Returns the spy so a test can read the URLs asked for. */
function stubApi(make: (url: string) => Response = () => okPage()) {
  const spy = vi.fn((url: string) => Promise.resolve(make(url)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderLogs(storage: StorageLike = signedIn()): void {
  render(
    h(AuthProvider, {
      storage,
      children: h(MemoryRouter, { initialEntries: ["/logs"] }, h(LogsView)),
    }),
  );
}

/** Every URL the view asked for, in order. */
function urls(spy: ReturnType<typeof stubApi>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe("LogsView", () => {
  it("should open on today's tool calls, which is the question it exists to answer", async () => {
    // Not "the whole log". A view that opens on a wall of service notices makes
    // the Commander do the filtering this page was built to have already done.
    const spy = stubApi();
    renderLogs();

    await waitFor(() => expect(urls(spy).length).toBeGreaterThan(0));
    const asked = urls(spy)[0] ?? "";

    expect(asked).toContain("/logs");
    expect(asked).toContain("event=turn.tool");
    expect(asked).toContain("since=");
  });

  it("should render every record in the page, newest first as the server sent them", async () => {
    stubApi();
    renderLogs();

    await waitFor(() => expect(screen.getByRole("table", { name: /log/i })).toBeTruthy());
    const rows = within(screen.getByRole("table", { name: /log/i })).getAllByRole("row").slice(1);

    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toContain("2026-08-10 13:06:00Z");
    expect(rows[4]?.textContent).toContain("2026-08-10 13:02:00Z");
  });

  it("should put the tool name in the row, because that is what she actually did", async () => {
    stubApi();
    renderLogs();

    await waitFor(() => expect(screen.getByRole("table", { name: /log/i })).toBeTruthy());
    const rows = within(screen.getByRole("table", { name: /log/i })).getAllByRole("row").slice(1);

    expect(rows[0]?.textContent).toContain("Bash");
    expect(rows[1]?.textContent).toContain("Read");
  });

  it("should summarise which tools were called and how often", async () => {
    stubApi();
    renderLogs();

    const tally = await screen.findByTestId("tool-tally");
    expect(tally.textContent).toContain("Bash ×2");
    expect(tally.textContent).toContain("Read ×1");
  });

  it("should ask the server again when the event filter changes", async () => {
    // The filtering is the server's, not a client-side slice of one page — a
    // page holds 200 records and the log holds a year of them.
    const spy = stubApi();
    renderLogs();
    await waitFor(() => expect(urls(spy).length).toBe(1));

    fireEvent.change(screen.getByLabelText(/showing/i), { target: { value: "" } });

    await waitFor(() => expect(urls(spy).length).toBe(2));
    expect(urls(spy)[1]).not.toContain("event=");
  });

  it("should send the level filter to the server rather than hiding rows locally", async () => {
    const spy = stubApi();
    renderLogs();
    await waitFor(() => expect(urls(spy).length).toBe(1));

    fireEvent.change(screen.getByLabelText(/level/i), { target: { value: "warn" } });

    await waitFor(() => expect(urls(spy).length).toBe(2));
    expect(urls(spy)[1]).toContain("level=warn");
  });

  it("should drop the time bound entirely when 'today only' is turned off", async () => {
    const spy = stubApi();
    renderLogs();
    await waitFor(() => expect(urls(spy).length).toBe(1));

    fireEvent.click(screen.getByLabelText(/today only/i));

    await waitFor(() => expect(urls(spy).length).toBe(2));
    expect(urls(spy)[1]).not.toContain("since=");
  });

  it("should say the page is incomplete when the server says there is more", async () => {
    // Silence here would let the Commander read a truncated page as the whole
    // answer, which is the failure mode of every log tool.
    stubApi(() => okPage(PAGE, true));
    renderLogs();

    await waitFor(() => expect(screen.getByText(/more beyond this page/i)).toBeTruthy());
  });

  it("should tell an empty result apart from a failure", async () => {
    stubApi(() => okPage([]));
    renderLogs();

    const empty = await screen.findByText(/nothing matches this filter/i);
    expect(empty.textContent).toContain("Nothing is being hidden");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should explain a FORBIDDEN as a scope problem with the command that fixes it", async () => {
    // The refusal a device-scoped key gets. "Forbidden" alone reads as a bug in
    // the admin rather than as the deliberate boundary it is.
    stubApi(() => forbidden());
    renderLogs();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const notice = await screen.findByTestId("admin-key-needed");

    expect(notice.textContent).toContain("admin");
    // The command, spelled out as its own element rather than only buried in
    // the server's sentence — this is the thing to copy.
    expect(within(notice).getByText("npm run pair -- --admin").tagName).toBe("CODE");
  });

  it("should keep the operator signed in when the log refuses their key", async () => {
    // A device key works everywhere else in this admin. Signing out over a 403
    // would drop a good credential and invite them to paste the same one back.
    const storage = signedIn();
    stubApi(() => forbidden());
    renderLogs(storage);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(storage.getItem(API_KEY_STORAGE_KEY)).not.toBeNull();
  });
});
