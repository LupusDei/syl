/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { HealthView } from "../../src/features/health/HealthView";
import { HEALTH_TYPES, type AuthorisationState } from "../../src/features/health/health-model";
import { createMemoryStorage, type StorageLike } from "../../src/storage";

/**
 * The health admin screen.
 *
 * Everything here is one assertion said several ways: **an authorised type with
 * no samples and an unread type with no samples must not look the same.** On his
 * real data that is the difference between "you took no steps today" and "we
 * have never been able to see your heart rate variability", and only the first
 * is a statement about his body.
 *
 * The assertions read `data-reading` and `data-standing` off the DOM rather than
 * grepping the prose. The distinction has to survive a copy-edit, and a test
 * that pins the wording goes red for a comma.
 */

/**
 * Pinned, because the window is RELATIVE.
 *
 * "Last 24 hours" evaluated against the wall clock would make every assertion
 * about which samples fall inside it a statement about the day the test was
 * run. Five time-dependent failures in this project already; `DevicesView`
 * carries the same seam.
 */
const NOW = new Date("2026-08-13T12:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signedIn(): StorageLike {
  const storage = createMemoryStorage();
  storage.setItem(API_KEY_STORAGE_KEY, "sk-syl-abc");
  return storage;
}

interface TypeAnswer {
  readonly state?: AuthorisationState | null;
  readonly silenceIsEvidence?: boolean;
  readonly samples?: readonly Record<string, unknown>[];
  readonly watermark?: string | null;
  /** The server's grounds for an inferred `unavailable` (`syl-8ys9.3.3`). */
  readonly unpublished?: Record<string, unknown> | null;
  readonly status?: number;
  readonly body?: string;
}

/** What the route sends beside an inferred `unavailable`. */
function grounds(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "heartRateVariability",
    reported: "denied",
    from: "2026-07-10",
    to: "2026-08-13",
    corroboratedDays: 35,
    corroboratedBy: ["heartRate", "sleep", "steps"],
    because: "Not one heartRateVariability sample has ever been held.",
    ...overrides,
  };
}

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "steps",
    startedAt: "2026-08-13T11:00:00.000Z",
    endedAt: "2026-08-13T11:01:00.000Z",
    value: 431,
    source: "iPhone",
    recordedAt: "2026-08-13T11:02:00.000Z",
    ...overrides,
  };
}

/**
 * A fake backend answering per type.
 *
 * The default is `undisclosed` with nothing in it, because that is what his
 * real device reports for the types it cannot prove it may read — the common
 * case, not an edge one.
 */
function stubApi(answers: Partial<Record<string, TypeAnswer>>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const type = new URL(url, "http://syl.test").searchParams.get("type") ?? "";
      const answer = answers[type] ?? {};
      if (answer.status !== undefined) {
        return Promise.resolve(
          new Response(
            answer.body ??
              JSON.stringify({
                success: false,
                error: { code: "INTERNAL_ERROR", message: "boom", retryable: false },
              }),
            { status: answer.status, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const state = answer.state === undefined ? "undisclosed" : answer.state;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              type,
              unit: "count",
              state,
              reportedAt: "2026-08-13T06:00:00.000Z",
              silenceIsEvidence: answer.silenceIsEvidence ?? state === "authorised",
              watermark: answer.watermark ?? null,
              unpublished: answer.unpublished ?? null,
              samples: answer.samples ?? [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }),
  );
}

function renderView(): void {
  render(
    h(AuthProvider, {
      storage: signedIn(),
      children: h(
        MemoryRouter,
        { initialEntries: ["/health"] },
        h(HealthView, { now: NOW }),
      ),
    }),
  );
}

function panel(type: string): HTMLElement {
  const found = screen.getByTestId(`health-type-${type}`);
  return found;
}

async function settled(type: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(panel(type).getAttribute("data-reading")).not.toBe("pending");
  });
  return panel(type);
}

describe("HealthView", () => {
  it("should render a panel for every stored type", async () => {
    stubApi({});
    renderView();

    for (const type of HEALTH_TYPES) {
      await settled(type);
    }
  });

  it("should render an EMPTY AUTHORISED type differently from an EMPTY UNREAD one", async () => {
    // The bead. Both are zero samples and both would be a flat line in any
    // chart library handed an empty array.
    stubApi({
      steps: { state: "authorised", samples: [] },
      heartRateVariability: { state: "undisclosed", samples: [] },
    });
    renderView();

    const authorised = await settled("steps");
    const unread = await settled("heartRateVariability");

    expect(authorised.getAttribute("data-reading")).toBe("measuredZero");
    expect(unread.getAttribute("data-reading")).toBe("notLooked");
    expect(authorised.getAttribute("data-evidence")).toBe("true");
    expect(unread.getAttribute("data-evidence")).toBe("false");

    // Not merely different attributes — different pixels.
    const authorisedBody = screen.getByTestId("health-silence-steps");
    const unreadBody = screen.getByTestId("health-silence-heartRateVariability");
    expect(authorisedBody.className).toContain("silence--measured");
    expect(unreadBody.className).toContain("silence--unlooked");
    expect(authorisedBody.textContent).not.toBe(unreadBody.textContent);
  });

  it("should DRAW a baseline for a measured zero and NO line at all for an unread type", async () => {
    // The channel that survives a screenshot with the labels cropped off. A
    // line under an unread type would be a measurement nobody took.
    stubApi({
      steps: { state: "authorised", samples: [] },
      heartRateVariability: { state: "undisclosed", samples: [] },
    });
    renderView();

    await settled("steps");
    await settled("heartRateVariability");

    expect(screen.getByTestId("health-silence-steps").querySelector("svg")).not.toBeNull();
    expect(
      screen.getByTestId("health-silence-heartRateVariability").querySelector("svg"),
    ).toBeNull();
  });

  it("should give each of the five authorisation states its own standing on the panel", async () => {
    stubApi({
      heartRate: { state: "authorised" },
      restingHeartRate: { state: "denied" },
      heartRateVariability: { state: "notDetermined" },
      sleep: { state: "undisclosed" },
      steps: { state: "unavailable" },
      workout: { state: null },
    });
    renderView();

    const seen: string[] = [];
    for (const type of HEALTH_TYPES) {
      const element = await settled(type);
      seen.push(element.getAttribute("data-standing") ?? "");
    }

    expect(seen).toContain("authorised");
    expect(seen).toContain("denied");
    expect(seen).toContain("notDetermined");
    expect(seen).toContain("undisclosed");
    expect(seen).toContain("unavailable");
    // `state: null` is its own standing, never `denied`.
    expect(seen).toContain("unreported");
  });

  it("should never advise a permission change for a type iOS simply will not confirm", async () => {
    stubApi({ heartRateVariability: { state: "undisclosed" } });
    renderView();

    await settled("heartRateVariability");
    const body = screen.getByTestId("health-silence-heartRateVariability");
    expect(body.textContent ?? "").toMatch(/nothing to do/i);
    expect(body.textContent ?? "").not.toMatch(/Privacy & Security/);
  });

  it("should render a FAILED type as neither empty nor unauthorised", async () => {
    // A request that never came back is a third thing. Rendering it as an
    // empty chart is the same conflation one layer over.
    stubApi({ sleep: { status: 500 } });
    renderView();

    const element = await settled("sleep");
    expect(element.getAttribute("data-reading")).toBe("failed");
    expect(element.textContent ?? "").toMatch(/could not be/i);
    expect(screen.queryByTestId("health-silence-sleep")).toBeNull();
  });

  it("should not let one failing type blank the others", async () => {
    stubApi({ sleep: { status: 500 }, steps: { state: "authorised", samples: [sample()] } });
    renderView();

    await settled("sleep");
    const steps = await settled("steps");
    expect(steps.getAttribute("data-reading")).toBe("samples");
  });

  it("should show the raw rows with their source", async () => {
    stubApi({
      steps: {
        state: "authorised",
        samples: [sample({ source: "Oura" }), sample({ source: "iPhone", value: 12 })],
      },
    });
    renderView();

    await settled("steps");
    const rows = screen.getByTestId("health-rows-steps");
    expect(rows.textContent).toContain("Oura");
    expect(rows.textContent).toContain("iPhone");
    expect(screen.getByTestId("health-sources-steps").textContent).toContain("Oura (1)");
  });

  it("should report the newest instant held over ALL time, not the last row in the window", async () => {
    // The store answers oldest-first and caps the answer, so the last row in a
    // long window is not the newest sample. Reading "is it still arriving?" off
    // that row would say the data stopped weeks ago.
    stubApi({
      steps: {
        state: "authorised",
        samples: [sample({ startedAt: "2026-08-13T00:00:00.000Z" })],
        watermark: "2026-08-13T11:59:00.000Z",
      },
    });
    renderView();

    await settled("steps");
    expect(screen.getByTestId("health-provenance-steps").textContent).toContain(
      "2026-08-13 11:59:00Z",
    );
  });

  it("should say when a server contradicts itself rather than quietly correcting it", async () => {
    stubApi({ steps: { state: "denied", silenceIsEvidence: true } });
    renderView();

    const element = await settled("steps");
    // Rendered the cautious way …
    expect(element.getAttribute("data-reading")).toBe("notLooked");
    // … and said so.
    expect(screen.getByTestId("health-disagrees-steps")).toBeTruthy();
  });

  it("should summarise the two kinds of empty separately, never as `no data`", async () => {
    stubApi({
      steps: { state: "authorised" },
      heartRate: { state: "undisclosed" },
    });
    renderView();

    await settled("steps");
    await waitFor(() => {
      const text = screen.getByTestId("health-summary").textContent ?? "";
      expect(text).toMatch(/quiet proves nothing/);
    });
    expect(screen.getByTestId("health-summary").textContent ?? "").not.toMatch(/no data/i);
  });

  it("should ask the backend for the window it is displaying", async () => {
    stubApi({});
    renderView();

    await settled("steps");
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
    const asked = calls.map(([url]) => url);
    expect(asked.length).toBe(HEALTH_TYPES.length);
    for (const url of asked) {
      const query = new URL(url, "http://syl.test").searchParams;
      expect(query.get("to")).toBe("2026-08-13T12:00:00.000Z");
      expect(query.get("from")).toBe("2026-08-12T12:00:00.000Z");
    }
  });

  it("should spell out every standing in the key, including the one no client can produce", async () => {
    stubApi({});
    renderView();

    await settled("steps");
    const key = screen.getByTestId("standing-key");
    for (const standing of [
      "authorised",
      "undisclosed",
      "notDetermined",
      "unavailable",
      "unpublished",
      "denied",
      "unreported",
    ]) {
      expect(key.querySelector(`[data-standing="${standing}"]`), standing).not.toBeNull();
    }
  });

  /**
   * `syl-8ys9.3.3` — the type his ring does not publish.
   *
   * The live case: `heartRateVariability` reports `denied`, is not denied, and
   * the server says so with the window it drew that from. This screen has to
   * show a seventh standing, keep it apart from the `unavailable` the PHONE
   * reports, and offer him no permission to change — because there is none that
   * would help.
   */
  it("should render a type nothing publishes apart from one the device cannot measure", async () => {
    stubApi({
      heartRateVariability: { state: "unavailable", unpublished: grounds() },
      // The phone's own `unavailable`, which means HealthKit is absent from the
      // device entirely. Same word on the wire, different fact.
      steps: { state: "unavailable" },
    });
    renderView();

    const never = await settled("heartRateVariability");
    const absent = await settled("steps");

    expect(never.getAttribute("data-standing")).toBe("unpublished");
    expect(absent.getAttribute("data-standing")).toBe("unavailable");
    // Neither is evidence about him, and both draw no line.
    expect(never.getAttribute("data-evidence")).toBe("false");
    expect(
      screen.getByTestId("health-silence-heartRateVariability").querySelector("svg"),
    ).toBeNull();
  });

  it("should never advise a permission change for a type no source publishes", async () => {
    // The useless-advice failure in its newest form. He granted it; nothing
    // writes it. Sending him to Settings is an errand that cannot succeed.
    stubApi({ heartRateVariability: { state: "unavailable", unpublished: grounds() } });
    renderView();

    await settled("heartRateVariability");
    const body = screen.getByTestId("health-silence-heartRateVariability").textContent ?? "";

    expect(body).not.toMatch(/Privacy & Security/);
    expect(body).not.toMatch(/Settings/);
    expect(body).toMatch(/not a permission/i);
  });

  it("should show the window the judgement was drawn from, because the server inferred it", async () => {
    stubApi({ heartRateVariability: { state: "unavailable", unpublished: grounds() } });
    renderView();

    await settled("heartRateVariability");
    const shown = screen.getByTestId("health-grounds-heartRateVariability").textContent ?? "";

    // The days, the window, and the label it overrode. An inference on this
    // screen shows its working or it is just an assertion in a nicer font.
    expect(shown).toMatch(/35 days/);
    expect(shown).toContain("2026-07-10");
    expect(shown).toContain("2026-08-13");
    expect(shown).toContain("denied");
  });

  it("should fall back to what the phone reported when the grounds arrive half-formed", async () => {
    // Fail closed. A finding with no window under it must not put a confident
    // sentence about his equipment on the screen; the honest fallback is the
    // state the phone actually sent.
    stubApi({
      heartRateVariability: {
        state: "denied",
        unpublished: { reported: "denied", corroboratedDays: 35 },
      },
    });
    renderView();

    const element = await settled("heartRateVariability");
    expect(element.getAttribute("data-standing")).toBe("denied");
    expect(screen.queryByTestId("health-grounds-heartRateVariability")).toBeNull();
  });
});
