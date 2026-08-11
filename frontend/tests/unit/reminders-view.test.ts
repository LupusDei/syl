/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Ok, Reminder, ReminderPage } from "@syl/shared/types";

import { RemindersView } from "../../src/features/reminders/RemindersView";
import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createMemoryStorage, type StorageLike } from "../../src/storage";
import { fixture, fixtureResponse } from "../helpers/fixtures";

const rows: readonly Reminder[] = (fixture("http/reminders.page") as Ok<ReminderPage>).data.items;
const noticed = rows.find((r) => r.origin === "she_noticed") as Reminder;
const unrecorded = rows.find((r) => r.origin === null) as Reminder;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

function stubApi(make: () => Response = () => fixtureResponse("http/reminders.page")) {
  const spy = vi.fn((_url: string) => Promise.resolve(make()));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderView(storage: StorageLike = signedIn()): void {
  render(
    h(AuthProvider, {
      storage,
      children: h(MemoryRouter, { initialEntries: ["/reminders"] }, h(RemindersView)),
    }),
  );
}

function pageOf(items: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({ success: true, data: { items, nextCursor: null, hasMore: false } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("RemindersView", () => {
  it("should show every reminder the page returned", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getAllByTestId("reminder-row")).toHaveLength(rows.length);
    });
  });

  it("should mark which reminders Syl thought of herself", async () => {
    // The design brief in one assertion: a list he can scan and think "she
    // thought of these". Without it he cannot tell her to stop making a kind
    // of suggestion he dislikes, which `SOUL.md` promises he can.
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getAllByText("Syl noticed")).toHaveLength(1);
    });
  });

  it("should show the reason a reminder exists", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getByText(String(noticed.because))).toBeTruthy();
    });
  });

  it("should count what she offered unprompted, so a pattern can be objected to", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId("provenance-summary").textContent).toContain(
        "1 Syl thought of herself",
      );
    });
  });

  it("should narrow to the ones she thought of when asked", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getAllByTestId("reminder-row")).toHaveLength(rows.length);
    });

    fireEvent.click(screen.getByRole("checkbox"));

    const shown = screen.getAllByTestId("reminder-row");
    expect(shown).toHaveLength(1);
    expect(shown[0]?.dataset["provenance"]).toBe("hers");
  });

  it("should say which filter is in force, so a short list is never misread", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getByText("showing every reminder")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("showing only what Syl thought of")).toBeTruthy();
  });

  it("should keep the summary counting the whole page, not the filtered view", async () => {
    // The number he wants is "how many of these did she think of". A count
    // that moved when he ticked the filter would answer a different question
    // and read as though the filter had changed the facts.
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId("provenance-summary").textContent).toContain("3 reminders");
    });

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("provenance-summary").textContent).toContain("3 reminders");
  });
});

/**
 * `syl-91z`, applied to the field this bead added.
 *
 * A null `because` means the row predates the record — `remind_me` refuses a
 * call without a reason, so a null cannot mean she declined to give one. The
 * UI must not render an older reminder as though Syl had failed to explain
 * herself, and must not render it as though something had broken either.
 */
describe("a reminder from before the reasons were kept", () => {
  it("should say what is true about the record rather than blame her", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId("reason-unrecorded").textContent).toBe(
        "recorded before Syl kept her reasons",
      );
    });
  });

  it("should never say a reason was missing, absent, or not given", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      expect(screen.getAllByTestId("reminder-row").length).toBeGreaterThan(0);
    });
    // Every one of these reads as a failure on her part rather than a fact
    // about when the row was written.
    for (const wording of [/no reason/i, /missing/i, /not given/i, /unknown/i, /unexplained/i]) {
      expect(screen.queryByText(wording)).toBeNull();
    }
  });

  it("should style the gap as unremarkable, never as an error", async () => {
    stubApi();
    renderView();
    const cell = await screen.findByTestId("reason-unrecorded");
    // `row__sub` is the quiet class every secondary line uses. `cell--error`
    // is what a genuine failure gets, and using it here would be the console
    // reporting its own history as a fault.
    expect(cell.className).toContain("row__sub");
    expect(cell.className).not.toContain("cell--error");
  });

  it("should not count an unattributed row as one she thought of", async () => {
    stubApi();
    renderView();
    await waitFor(() => {
      const row = screen
        .getAllByTestId("reminder-row")
        .find((r) => r.textContent?.includes(unrecorded.text));
      expect(row?.dataset["provenance"]).toBe("unrecorded");
    });
  });

  it("should tell an empty page from a failed one", async () => {
    // The rule this whole describe is named for, at the page level: a request
    // that failed and a page with nothing in it must not look alike.
    stubApi(() => pageOf([]));
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/the server returned none/i)).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should raise a failed request as a failure, not as an empty list", async () => {
    stubApi(
      () =>
        new Response(JSON.stringify({ success: false, error: { code: "BOOM", message: "no" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    renderView();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.queryByText(/the server returned none/i)).toBeNull();
  });
});
