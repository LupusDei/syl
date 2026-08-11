/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationsView } from "../../src/features/conversations/ConversationsView";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createMemoryStorage, type StorageLike } from "../../src/storage";
import { fixtureResponse } from "../helpers/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

function stubApi(overrides: Readonly<Record<string, () => Response>> = {}) {
  const spy = vi.fn((url: string) => {
    for (const [fragment, make] of Object.entries(overrides)) {
      if (url.includes(fragment)) return Promise.resolve(make());
    }
    if (url.includes("/messages")) return Promise.resolve(fixtureResponse("http/messages.page"));
    return Promise.resolve(fixtureResponse("http/conversations.page"));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderView(path = "/conversations", storage: StorageLike = signedIn()): void {
  render(
    h(AuthProvider, {
      storage,
      children: h(
        MemoryRouter,
        { initialEntries: [path] },
        h(
          Routes,
          null,
          h(Route, { path: "/conversations", element: h(ConversationsView) }),
          h(Route, { path: "/conversations/:conversationId", element: h(ConversationsView) }),
        ),
      ),
    }),
  );
}

const INTERACTIVE_ID = "syl:conversation:00000000-0000-7000-8000-000000000001";

describe("ConversationsView", () => {
  it("should list both lanes with the Commander's thread first", async () => {
    stubApi();
    renderView();

    await waitFor(() => expect(screen.getByText("The Commander's thread")).toBeTruthy());
    expect(screen.getByText("Research brief: local-first sync on iOS")).toBeTruthy();
  });

  it("should filter by lane through the server", async () => {
    const spy = stubApi();
    renderView();
    await waitFor(() => expect(spy).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/lane/i), { target: { value: "job" } });

    await waitFor(() => expect(spy.mock.calls.some(([url]) => url.includes("lane=job"))).toBe(true));
  });

  it("should open a transcript oldest-first when a lane is selected", async () => {
    stubApi();
    renderView();
    await waitFor(() => expect(screen.getByText("The Commander's thread")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "The Commander's thread" }));

    await waitFor(() => expect(screen.getByRole("table", { name: /transcript/i })).toBeTruthy());
    const seqs = screen
      .getAllByRole("rowheader")
      .map((cell) => Number(cell.textContent))
      .filter((value) => Number.isFinite(value) && value > 0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("should open straight onto a transcript when the URL names a lane", async () => {
    stubApi();
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);

    await waitFor(() => expect(screen.getByRole("table", { name: /transcript/i })).toBeTruthy());
    expect(screen.getByText(/Remind me to call the pharmacy/)).toBeTruthy();
  });

  it("should say that search only covers what is loaded", async () => {
    // The contract has no message search. A box that silently covered only the
    // last hundred messages would be worse than none.
    stubApi();
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);

    await waitFor(() =>
      expect(screen.getByText(/no server-side message search in the contract/i)).toBeTruthy(),
    );
  });

  it("should narrow the transcript as the operator types", async () => {
    stubApi();
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);
    await waitFor(() => expect(screen.getByRole("table", { name: /transcript/i })).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/search/i), { target: { value: "pharmacy" } });

    expect(screen.getByText(/Remind me to call the pharmacy/)).toBeTruthy();
    expect(screen.queryByText(/4:00 this afternoon/)).toBeNull();
  });

  it("should distinguish nothing matching from an empty lane", async () => {
    stubApi();
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);
    await waitFor(() => expect(screen.getByRole("table", { name: /transcript/i })).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/search/i), { target: { value: "zzz-nothing" } });
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
  });

  it("should show the clientId an optimistic send reconciles by", async () => {
    stubApi();
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);

    await waitFor(() =>
      expect(screen.getByText("c8f41d02-6b1e-4a77-9f30-2ab5c9d10e44")).toBeTruthy(),
    );
  });

  it("should warn when the loaded page has holes in its sequence", async () => {
    const gapped = {
      success: true,
      data: {
        items: [
          {
            id: "syl:message:a",
            conversationId: INTERACTIVE_ID,
            clientId: null,
            role: "assistant",
            text: "one",
            createdAt: "2026-08-09T07:00:00.000Z",
            seq: 1,
          },
          {
            id: "syl:message:b",
            conversationId: INTERACTIVE_ID,
            clientId: null,
            role: "assistant",
            text: "five",
            createdAt: "2026-08-09T07:00:05.000Z",
            seq: 5,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    };
    stubApi({
      "/messages": () =>
        new Response(JSON.stringify(gapped), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);

    await waitFor(() => expect(screen.getByText(/this page has gaps/i)).toBeTruthy());
  });

  it("should close the transcript again", async () => {
    stubApi();
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);
    await waitFor(() => expect(screen.getByRole("table", { name: /transcript/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("table", { name: /transcript/i })).toBeNull());
  });

  it("should report a failed lane request loudly", async () => {
    stubApi({ "/conversations": () => fixtureResponse("errors/not_found", 404) });
    renderView();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("should report a failed transcript request without losing the lane list", async () => {
    stubApi({ "/messages": () => fixtureResponse("errors/not_found", 404) });
    renderView(`/conversations/${encodeURIComponent(INTERACTIVE_ID)}`);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("table", { name: /lanes/i })).toBeTruthy();
  });

  it("should say when a filter matches no lane", async () => {
    stubApi({
      "/conversations": () =>
        new Response(
          JSON.stringify({ success: true, data: { items: [], nextCursor: null, hasMore: false } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    renderView();

    await waitFor(() => expect(screen.getByText(/No conversation lane matches/)).toBeTruthy());
  });

  it("should render nothing to load while signed out", () => {
    stubApi();
    renderView("/conversations", createMemoryStorage());
    expect(screen.queryByRole("table")).toBeNull();
  });
});
