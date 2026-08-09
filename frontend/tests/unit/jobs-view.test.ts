/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement as h, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobsView } from "../../src/features/jobs/JobsView";
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

/**
 * The backend, faked at the network boundary with the shipped fixtures — the
 * same bytes `npm run mock` serves.
 */
function stubApi(overrides: Readonly<Record<string, () => Response>> = {}) {
  const spy = vi.fn((url: string) => {
    for (const [fragment, make] of Object.entries(overrides)) {
      if (url.includes(fragment)) return Promise.resolve(make());
    }
    if (url.includes("/runs")) return Promise.resolve(fixtureResponse("http/runs.page"));
    if (url.includes("/jobs")) return Promise.resolve(fixtureResponse("http/jobs.page"));
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function renderJobs(path = "/jobs", storage: StorageLike = signedIn()): ReactElement {
  const tree = h(
    AuthProvider,
    {
      storage,
      children: h(
        MemoryRouter,
        { initialEntries: [path] },
        h(
          Routes,
          null,
          h(Route, { path: "/jobs", element: h(JobsView) }),
          h(Route, { path: "/jobs/:jobId", element: h(JobsView) }),
        ),
      ),
    },
  );
  render(tree);
  return tree;
}

const JOB_ID = "syl:job:0198f2c4-0003-7000-8000-00000000e003";

describe("JobsView", () => {
  it("should list every job in the page, trouble first", async () => {
    stubApi();
    renderJobs();

    await waitFor(() => expect(screen.getByRole("table", { name: /jobs/i })).toBeTruthy());
    const rows = within(screen.getByRole("table", { name: /jobs/i })).getAllByRole("row").slice(1);

    expect(rows.length).toBe(4);
    // The half-open breaker sorts above everything healthy.
    expect(rows[0]?.textContent).toContain("nightly consolidation");
    expect(rows[0]?.textContent).toContain("half open · 2 failures");
  });

  it("should show a wall-clock trigger with its zone, never the instant alone", async () => {
    stubApi();
    renderJobs();

    await waitFor(() => expect(screen.getByText("07:00 America/Chicago · FREQ=DAILY")).toBeTruthy());
  });

  it("should say a job is silent rather than leaving it to be inferred", async () => {
    stubApi();
    renderJobs();

    await waitFor(() => expect(screen.getAllByText("silent").length).toBeGreaterThan(0));
  });

  it("should filter by state through the server, not by hiding rows locally", async () => {
    const spy = stubApi();
    renderJobs();
    await waitFor(() => expect(spy).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "failed" } });

    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => url.includes("state=failed"))).toBe(true),
    );
  });

  it("should load the runs of a job when it is selected", async () => {
    stubApi();
    renderJobs();
    await waitFor(() => expect(screen.getByText("morning agenda")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "morning agenda" }));

    await waitFor(() => expect(screen.getByRole("table", { name: /runs/i })).toBeTruthy());
    expect(screen.getByText("+6m 31s")).toBeTruthy();
  });

  it("should open straight onto a job's runs when the URL names one", async () => {
    stubApi();
    renderJobs(`/jobs/${encodeURIComponent(JOB_ID)}`);

    await waitFor(() => expect(screen.getByRole("table", { name: /runs/i })).toBeTruthy());
    expect(screen.getByText(/Runs of morning agenda/)).toBeTruthy();
  });

  it("should show the lateness of every run, including the small ones", async () => {
    // A run that fired 140ms late says so. Rounding that to "on time" is the
    // lie the lateness column exists to prevent.
    stubApi();
    renderJobs(`/jobs/${encodeURIComponent(JOB_ID)}`);

    await waitFor(() => expect(screen.getByRole("table", { name: /runs/i })).toBeTruthy());
    expect(screen.getByText("+140ms")).toBeTruthy();
    expect(screen.getByText("+6m 31s")).toBeTruthy();
  });

  it("should expand a run into its steps, session id included", async () => {
    stubApi();
    renderJobs(`/jobs/${encodeURIComponent(JOB_ID)}`);
    await waitFor(() => expect(screen.getByRole("table", { name: /runs/i })).toBeTruthy());

    const expander = screen.getAllByRole("button", { name: "2 steps" })[0];
    if (expander === undefined) throw new Error("expected a run with steps");
    fireEvent.click(expander);

    // The session id is the point: it is what `claude --resume` takes.
    expect(screen.getAllByText("1f4c9a2b-7d31-4e88-b0a5-6c2e9f0d3a17").length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(screen.queryByText("1f4c9a2b-7d31-4e88-b0a5-6c2e9f0d3a17")).toBeNull();
  });

  it("should close the run panel again", async () => {
    stubApi();
    renderJobs(`/jobs/${encodeURIComponent(JOB_ID)}`);
    await waitFor(() => expect(screen.getByRole("table", { name: /runs/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("table", { name: /runs/i })).toBeNull());
  });

  it("should report a failed request loudly instead of showing an empty table", async () => {
    // An empty panel because the request failed and an empty panel because
    // there is nothing to show must never look alike.
    stubApi({ "/jobs": () => fixtureResponse("errors/not_found", 404) });
    renderJobs();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("NOT_FOUND");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("should offer a retry that asks again", async () => {
    const spy = stubApi({ "/jobs": () => fixtureResponse("errors/not_found", 404) });
    renderJobs();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const before = spy.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before));
  });

  it("should say a page is genuinely empty rather than looking broken", async () => {
    const empty = { success: true, data: { items: [], nextCursor: null, hasMore: false } };
    stubApi({
      "/jobs": () =>
        new Response(JSON.stringify(empty), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    renderJobs();

    await waitFor(() => expect(screen.getByText(/Nothing is being hidden/)).toBeTruthy());
  });

  it("should render nothing to load while signed out", () => {
    stubApi();
    renderJobs("/jobs", createMemoryStorage());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("should render every job in the shipped page, by kind and by id", async () => {
    // A guard against this view drifting from the contract: the fixture is
    // the same bytes the mock serves and the Swift suite decodes.
    const page = fixture("http/jobs.page") as { data: { items: { kind: string; id: string }[] } };
    stubApi();
    renderJobs();

    await waitFor(() => expect(screen.getByRole("table", { name: /jobs/i })).toBeTruthy());
    for (const job of page.data.items) {
      const trigger = screen.getByRole("button", { name: job.kind.replace(/_/g, " ") });
      expect(trigger.getAttribute("title")).toBe(job.id);
    }
  });
});
