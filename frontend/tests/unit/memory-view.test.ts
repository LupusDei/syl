/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement as h } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_KEY_STORAGE_KEY } from "../../src/auth/api-key-store";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { MemoryView } from "../../src/features/memory/MemoryView";
import type {
  ColdSampleEdge,
  ColdShapeView,
  InvariantAlarm,
  MemoryEdgeView,
  MemoryGraphView,
  MemoryMetricsView,
  MemoryNodeView,
  Rate,
} from "../../src/features/memory/memory-model";
import { createMemoryStorage, type StorageLike } from "../../src/storage";

/**
 * The memory viewer, driven through the network boundary.
 *
 * There is no shared fixture for these payloads on purpose: the memory routes
 * are not in `shared/openapi.yaml` yet, and adding a fixture would oblige SylKit
 * to model a surface the phone is forbidden to call. The shapes here are built
 * to `backend/src/routes/memory.ts`, and the backend suite pins them there.
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

const LAW = { halfLifeMs: 1_814_400_000, relevanceFloor: 0.05, traversalCap: 0.5, engagementCap: 1 };

function node(id: string, label: string): MemoryNodeView {
  return {
    id,
    tier: "hot",
    kind: "fact",
    label,
    body: null,
    subjectId: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function inferredEdge(overrides: Partial<MemoryEdgeView> = {}): MemoryEdgeView {
  return {
    id: "edge-inferred",
    kind: "inferred",
    tier: "hot",
    sourceNode: "n1",
    targetNode: "n2",
    relation: "blocked_by",
    storedWeight: 0.8,
    effectiveWeight: 0.76,
    confidence: 0.7,
    reasoning: "Both slipped in the same week, so one probably gates the other.",
    assertedBy: null,
    demoteAfter: "2026-11-09T00:00:00.000Z",
    lastTouchedAt: "2026-08-09T00:00:00.000Z",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    origin: "dream",
    ...overrides,
  };
}

function observedEdge(overrides: Partial<MemoryEdgeView> = {}): MemoryEdgeView {
  return {
    ...inferredEdge(),
    id: "edge-observed",
    kind: "observed",
    relation: "asserts",
    sourceNode: "n2",
    targetNode: "n3",
    confidence: null,
    reasoning: null,
    assertedBy: "n3",
    demoteAfter: null,
    origin: "hot_region",
    ...overrides,
  };
}

function graphView(overrides: Partial<MemoryGraphView> = {}): MemoryGraphView {
  return {
    generatedAt: "2026-08-10T02:00:00.000Z",
    scope: {
      tier: "hot",
      nodeSeeds: 40,
      edgeBudget: 200,
      nights: 7,
      seedsUsed: 3,
      edgesReturned: 2,
      edgeBudgetExhausted: false,
      nightsReturned: 0,
      moreNights: false,
      dreamHasEverRun: false,
      explanation: "The hot region plus the last 7 night(s). This is NOT the whole store.",
    },
    law: LAW,
    nodes: [node("n1", "Ship the memory viewer"), node("n2", "The dream"), node("n3", "settings.json")],
    edges: [inferredEdge(), observedEdge()],
    nights: [],
    superseded: [],
    ...overrides,
  };
}

function rate(value: number | null, why: string | null = null): Rate {
  return { numerator: value === null ? 0 : 3, denominator: value === null ? 0 : 4, value, undefinedBecause: why };
}

function alarm(overrides: Partial<InvariantAlarm> = {}): InvariantAlarm {
  return {
    status: "unproven",
    severity: "unknown",
    headline: "UNPROVEN: no dream has ever inserted an edge, so the lookup has never been exercised.",
    total: 0,
    byExistingTier: { hot: 0, cold: 0, suppressed: 0, unrecorded: 0 },
    insertionsAttempted: 0,
    ...overrides,
  };
}

function metricsView(overrides: Partial<MemoryMetricsView> = {}): MemoryMetricsView {
  const nothing = "nothing has been surfaced to him yet, so there is no engagement rate";
  return {
    alarm: alarm(),
    generatedAt: "2026-08-10T02:00:00.000Z",
    store: {
      nodes: { total: 3 },
      edges: { total: 2, observed: 1, inferred: 1, active: 1, dormant: 0, suppressed: 0 },
      inferredWeights: {
        buckets: [],
        total: 0,
        bottomHeavy: rate(null, "there are no inferred edges yet, so the histogram has no shape"),
        basis: "stored",
      },
      supersessions: 0,
      databaseBytes: 1_048_576,
    },
    survival: {
      overall: rate(null, "no edges have been created yet, so there is no survival rate — this is not a rate of zero"),
      hasEvidence: false,
      vanished: 0,
    },
    reactivation: {
      nights: 0,
      reactivated: 0,
      demoted: 0,
      rate: rate(null, "nothing has ever been demoted, so nothing could come back"),
      triggers: [],
      verdict: { kind: "no_dreams_yet", headline: "No dream has run yet." },
    },
    engagement: {
      surfaced: 0,
      answered: 0,
      engagedRate: rate(null, nothing),
      ignoredRate: rate(null, nothing),
      rejectedRate: rate(null, nothing),
      hasEvidence: false,
    },
    cost: {
      tokensSpent: 0,
      costUsd: 0,
      edgesKept: 0,
      tokensPerKeptEdge: rate(null, "no edges have been created yet, so there is no cost per kept edge"),
      usdPerKeptEdge: rate(null, "no edges have been created yet, so there is no cost per kept edge"),
      keptNothing: false,
      understated: false,
    },
    cold: {
      alarm: alarm(),
      shape: coldShape(),
      resurrection: {
        nights: 0,
        reactivated: 0,
        demoted: 0,
        rate: rate(null, "nothing has ever been demoted, so nothing could come back"),
        triggers: [],
        verdict: { kind: "no_dreams_yet", headline: "No dream has run yet." },
      },
      sample: [],
    },
    ...overrides,
  };
}

function coldShape(overrides: Partial<ColdShapeView> = {}): ColdShapeView {
  return {
    edges: 0,
    inferred: 0,
    observed: 0,
    oldestEnteredAt: null,
    oldestAgeMs: null,
    timeInCold: null,
    enteredBasis: "moved_at",
    growthPerNight: [],
    crossingRatePerNight: rate(null, "no night has run yet, so there is no crossing rate"),
    ...overrides,
  };
}

function coldEdge(overrides: Partial<ColdSampleEdge> = {}): ColdSampleEdge {
  return {
    id: "cold-1",
    tier: "cold",
    relation: "reminds_of",
    sourceNode: "n1",
    targetNode: "n2",
    sourceLabel: "The bridge four transcript",
    targetLabel: "The reminder that never fired",
    weight: 0.03,
    confidence: 0.4,
    reasoning: "Both were about promises the system could not keep, three weeks apart.",
    enteredColdAt: "2026-07-01T00:00:00.000Z",
    ageMs: 40 * 86_400_000,
    ...overrides,
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function forbidden(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "This endpoint needs a key with admin scope.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** The network, faked. Returns every call so a test can read what was sent. */
function stubApi(
  make: (url: string, init: RequestInit | undefined) => Response = (url) =>
    url.includes("/metrics") ? ok(metricsView()) : ok(graphView()),
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(make(String(url), init));
    }),
  );
  return calls;
}

function renderMemory(storage: StorageLike = signedIn()): void {
  render(
    h(AuthProvider, {
      storage,
      children: h(MemoryRouter, { initialEntries: ["/memory"] }, h(MemoryView)),
    }),
  );
}

describe("MemoryView — the picture", () => {
  it("should draw inferred edges dashed and observed edges solid", async () => {
    // The requirement the Commander stated. If the view lets him confuse the
    // two he cannot judge the inferred engine, which is what he asked to watch.
    stubApi();
    renderMemory();

    const dashed = await screen.findByTestId("edge-edge-inferred");
    const solid = screen.getByTestId("edge-edge-observed");

    expect(dashed.getAttribute("data-species")).toBe("inferred");
    expect(dashed.getAttribute("data-dash")).not.toBe("solid");
    expect(solid.getAttribute("data-species")).toBe("observed");
    expect(solid.getAttribute("data-dash")).toBe("solid");
  });

  it("should carry a legend that shows the two strokes rather than describing them", async () => {
    stubApi();
    renderMemory();

    const legend = await screen.findByTestId("species-legend");

    expect(legend.textContent).toContain("Observed");
    expect(legend.textContent).toContain("Inferred");
    expect(legend.querySelectorAll("line")).toHaveLength(2);
  });

  it("should say what it left out instead of presenting a slice as the whole store", async () => {
    stubApi();
    renderMemory();

    const note = await screen.findByTestId("scope-note");

    expect(note.textContent).toContain("NOT the whole store");
  });

  it("should show every inferred edge's reasoning as a cell, not a tooltip", async () => {
    // An inferred edge whose justification is one hover away is an edge nobody
    // ever judges.
    stubApi();
    renderMemory();

    const row = await screen.findByTestId("edge-row-edge-inferred");

    expect(row.textContent).toContain("Both slipped in the same week");
  });

  it("should give an observed edge its provenance and never a reasoning", async () => {
    stubApi();
    renderMemory();

    const row = await screen.findByTestId("edge-row-edge-observed");

    expect(row.textContent).toContain("Asserted by");
    expect(row.textContent).toContain("carries no reasoning");
  });
});

describe("MemoryView — the correction surface", () => {
  it("should POST a rejection with an idempotency key", async () => {
    const calls = stubApi((url) => {
      if (url.includes("/feedback")) {
        return ok({
          verdict: "reject",
          edge: { ...inferredEdge(), tier: "suppressed", storedWeight: 0.016 },
          weightBefore: 0.76,
          weightAfter: 0.016,
          surfacedRecorded: 0,
        });
      }
      return url.includes("/metrics") ? ok(metricsView()) : ok(graphView());
    });
    renderMemory();

    const row = await screen.findByTestId("edge-row-edge-inferred");
    fireEvent.click(within(row).getByRole("button", { name: /reject/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("/feedback"))).toBe(true);
    });
    const write = calls.find((call) => call.url.includes("/feedback"));
    expect(write?.init?.method).toBe("POST");
    expect(new Headers(write?.init?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(String(write?.init?.body)).toContain("reject");
  });

  it("should offer confirm as its own verdict, because engagement is the only lift above her cap", async () => {
    const calls = stubApi((url) =>
      url.includes("/feedback")
        ? ok({
            verdict: "confirm",
            edge: inferredEdge({ storedWeight: 0.96 }),
            weightBefore: 0.76,
            weightAfter: 0.96,
            surfacedRecorded: 0,
          })
        : url.includes("/metrics")
          ? ok(metricsView())
          : ok(graphView()),
    );
    renderMemory();

    const row = await screen.findByTestId("edge-row-edge-inferred");
    fireEvent.click(within(row).getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(calls.some((call) => String(call.init?.body).includes("confirm"))).toBe(true);
    });
    const receipt = await screen.findByTestId("verdict-receipt");
    expect(receipt.textContent).toContain("Confirmed");
  });

  it("should say loudly when a verdict did not land, because Syl still believes it", async () => {
    stubApi((url) => {
      if (url.includes("/feedback")) {
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "CONFLICT",
              message: "That edge is already suppressed.",
              retryable: false,
              details: null,
              retryAfterMs: null,
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return url.includes("/metrics") ? ok(metricsView()) : ok(graphView());
    });
    renderMemory();

    const row = await screen.findByTestId("edge-row-edge-inferred");
    fireEvent.click(within(row).getByRole("button", { name: /reject/i }));

    const failure = await screen.findByTestId("verdict-failed-edge-inferred");
    expect(failure.textContent).toContain("Syl still believes this");
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("should offer no verdict buttons on an edge he has already rejected", async () => {
    // He said no once. The row stays visible — nothing is deleted — but there
    // is nothing left to click.
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(metricsView())
        : ok(graphView({ edges: [inferredEdge({ tier: "suppressed" })] })),
    );
    renderMemory();

    const row = await screen.findByTestId("edge-row-edge-inferred");

    expect(within(row).queryByRole("button", { name: /reject/i })).toBeNull();
    expect(row.textContent).toContain("Nothing brings it back implicitly");
  });
});

describe("MemoryView — the alarm", () => {
  it("should never render `unproven` as a passing check", async () => {
    stubApi();
    renderMemory();

    const banner = await screen.findByTestId("invariant-alarm");

    expect(banner.getAttribute("data-status")).toBe("unproven");
    expect(banner.textContent).toContain("UNPROVEN");
    expect(banner.textContent).toContain("no evidence either way");
  });

  it("should shout a resurrected rejection in its own words, not as an error count", async () => {
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(
            metricsView({
              alarm: alarm({
                status: "rejected_connection_resurrected",
                severity: "trust_failure",
                headline: "TRUST FAILURE: reflection tried to resurrect 1 connection you REJECTED.",
                total: 3,
                byExistingTier: { hot: 0, cold: 2, suppressed: 1, unrecorded: 0 },
                insertionsAttempted: 40,
              }),
            }),
          )
        : ok(graphView()),
    );
    renderMemory();

    const banner = await screen.findByTestId("invariant-alarm");

    expect(banner.getAttribute("data-trust-failure")).toBe("true");
    expect(banner.textContent).toContain("TRUST FAILURE");
    // The suppressed count keeps its own place; it is not averaged into the
    // two cold breaches that outnumber it.
    expect(banner.textContent).toContain("1 against a REJECTED edge");
  });

  it("should put the alarm above the graph, where it cannot be scrolled past", async () => {
    stubApi();
    renderMemory();

    const banner = await screen.findByTestId("invariant-alarm");
    const canvas = screen.getByRole("img", { name: /memory graph/i });

    expect(banner.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("MemoryView — null is not zero", () => {
  it("should render an undefined rate as its reason, never as 0%", async () => {
    stubApi();
    renderMemory();

    const cell = await screen.findByTestId("engaged-rate");

    expect(cell.getAttribute("data-known")).toBe("false");
    expect(cell.textContent).toContain("nothing has been surfaced");
    expect(cell.textContent).not.toContain("0%");
  });

  it("should render a real rate as a percentage with its counts", async () => {
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(
            metricsView({
              engagement: {
                surfaced: 4,
                answered: 4,
                engagedRate: rate(0.75),
                ignoredRate: rate(0.25),
                rejectedRate: rate(0),
                hasEvidence: true,
              },
            }),
          )
        : ok(graphView()),
    );
    renderMemory();

    const cell = await screen.findByTestId("engaged-rate");

    expect(cell.getAttribute("data-known")).toBe("true");
    expect(cell.textContent).toContain("75%");
    expect(cell.textContent).toContain("3 of 4");
  });

  it("should refuse to draw an empty histogram as a row of zeroed bars", async () => {
    // Bars of length zero read as a measured, flat distribution. There is no
    // distribution.
    stubApi();
    renderMemory();

    const empty = await screen.findByTestId("histogram-empty");

    expect(empty.textContent).toContain("no shape");
    expect(screen.getByTestId("weight-histogram").querySelectorAll(".histogram__fill")).toHaveLength(0);
  });
});

describe("MemoryView — the empty state", () => {
  it("should say plainly that nothing has run, without looking broken", async () => {
    // The state he will actually see first.
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(metricsView())
        : ok(graphView({ nodes: [], edges: [], nights: [] })),
    );
    renderMemory();

    const empty = await screen.findByTestId("memory-empty");

    expect(empty.getAttribute("data-reason")).toBe("no_dream_yet");
    expect(empty.textContent).toContain("nothing is wrong");
    expect(empty.textContent).toContain("not a failed request");
    // Emphatically not the error notice, which is the loudest thing on the page.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should keep the metrics panel up even with an empty graph", async () => {
    stubApi((url) =>
      url.includes("/metrics") ? ok(metricsView()) : ok(graphView({ nodes: [], edges: [] })),
    );
    renderMemory();

    expect(await screen.findByTestId("metrics-panel")).toBeTruthy();
    expect(screen.getByTestId("invariant-alarm")).toBeTruthy();
  });

  it("should tell an empty store apart from a failed request", async () => {
    stubApi(() => forbidden());
    renderMemory();

    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    const notice = await screen.findByTestId("admin-key-needed");

    expect(notice.textContent).toContain("admin");
    expect(within(notice).getByText("npm run pair -- --admin").tagName).toBe("CODE");
    expect(screen.queryByTestId("memory-empty")).toBeNull();
  });

  it("should keep the operator signed in when the graph refuses their device key", async () => {
    const storage = signedIn();
    stubApi(() => forbidden());
    renderMemory(storage);

    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(storage.getItem(API_KEY_STORAGE_KEY)).not.toBeNull();
  });
});

describe("MemoryView — the cold store he can eyeball", () => {
  it("should show each dormant edge with the reasoning that justified it, untruncated", async () => {
    // The Commander asked for this by name. Metrics say whether the machinery
    // works; only he can say whether anything valuable is down there, and he
    // cannot if it is never on a screen.
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(
            metricsView({
              cold: {
                alarm: alarm(),
                shape: coldShape({ edges: 4, inferred: 4, timeInCold: { p50Ms: 8.64e7, p90Ms: 1.7e8, maxMs: 3.4e8 } }),
                resurrection: metricsView().cold.resurrection,
                sample: [coldEdge()],
              },
            }),
          )
        : ok(graphView()),
    );
    renderMemory();

    const row = await screen.findByTestId("cold-sample-cold-1");

    expect(row.textContent).toContain(
      "Both were about promises the system could not keep, three weeks apart.",
    );
    expect(row.textContent).toContain("The bridge four transcript");
    expect(row.textContent).toContain("reminds_of");
  });

  it("should say nothing has decayed yet rather than implying the store is clean", async () => {
    // An empty sample is NOT "nothing is down there". Early on there are no
    // cold edges because nothing has had time to decay.
    stubApi();
    renderMemory();

    const empty = await screen.findByTestId("cold-sample-empty");

    expect(empty.getAttribute("data-reason")).toBe("nothing_cold_yet");
    expect(empty.textContent).toContain("not a clean store");
  });

  it("should say when the dormant set holds only observations, which carry no reasoning", async () => {
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(
            metricsView({
              cold: {
                alarm: alarm(),
                shape: coldShape({ edges: 3, inferred: 0, observed: 3 }),
                resurrection: metricsView().cold.resurrection,
                sample: [],
              },
            }),
          )
        : ok(graphView()),
    );
    renderMemory();

    const empty = await screen.findByTestId("cold-sample-empty");

    expect(empty.getAttribute("data-reason")).toBe("only_observed_cold");
    expect(empty.textContent).toContain("the machinery is moving");
  });

  it("should refuse to render a missing time-in-cold distribution as a duration of zero", async () => {
    stubApi();
    renderMemory();

    const cell = await screen.findByTestId("time-in-cold");

    expect(cell.getAttribute("data-known")).toBe("false");
    expect(cell.textContent).toContain("not a duration of zero");
  });

  it("should show what came back and in whose words, as evidence for never-prune", async () => {
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(
            metricsView({
              cold: {
                alarm: alarm(),
                shape: coldShape({ edges: 2, inferred: 2 }),
                resurrection: {
                  nights: 12,
                  reactivated: 1,
                  demoted: 9,
                  rate: rate(0.11),
                  triggers: [
                    {
                      edgeId: "cold-1",
                      night: "2026-08-08",
                      reasoning: "He asked about the bridge again, so this connection matters after all.",
                      confidence: 0.6,
                      at: "2026-08-08T05:00:00.000Z",
                    },
                  ],
                  verdict: {
                    kind: "reactivation_happens",
                    headline: "The sweep has rediscovered 1 dormant edge across 12 nights.",
                  },
                },
                sample: [coldEdge()],
              },
            }),
          )
        : ok(graphView()),
    );
    renderMemory();

    const panel = await screen.findByTestId("cold-store-panel");

    expect(panel.textContent).toContain("He asked about the bridge again");
    expect(panel.textContent).toContain("rediscovered 1 dormant edge");
  });
});

describe("MemoryView — the dream window", () => {
  it("should ask the server again when the night window changes", async () => {
    const calls = stubApi();
    renderMemory();
    await waitFor(() => expect(calls.some((call) => call.url.includes("/memory/graph"))).toBe(true));

    fireEvent.change(screen.getByLabelText(/nights of reflection/i), { target: { value: "30" } });

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("nights=30"))).toBe(true);
    });
  });

  it("should show a night's rejections alongside what it created", async () => {
    // A panel that showed only what was created would flatter the engine by
    // construction, hiding every candidate it proposed and threw away.
    stubApi((url) =>
      url.includes("/metrics")
        ? ok(metricsView())
        : ok(
            graphView({
              scope: { ...graphView().scope, dreamHasEverRun: true, nightsReturned: 1 },
              nights: [
                {
                  sessionId: "s1",
                  night: "2026-08-09",
                  tz: "America/Chicago",
                  startedAt: "2026-08-09T04:00:00.000Z",
                  endedAt: "2026-08-09T05:00:00.000Z",
                  outcome: "completed",
                  error: null,
                  tokensSpent: 12_000,
                  costUsd: 0,
                  turns: 4,
                  counts: {
                    candidatesProposed: 9,
                    candidatesJudged: 9,
                    edgesCreated: 1,
                    edgesReactivated: 0,
                    edgesSuppressed: 0,
                    nodesSuperseded: 1,
                    edgesDemoted: 2,
                  },
                  dispositions: [
                    {
                      id: 1,
                      disposition: "created",
                      edgeId: "edge-inferred",
                      sourceNode: "n1",
                      targetNode: "n2",
                      tierBefore: null,
                      tierAfter: "hot",
                      reasoning: "A guess worth keeping.",
                      confidence: 0.7,
                      createdAt: "2026-08-09T04:30:00.000Z",
                    },
                    {
                      id: 2,
                      disposition: "rejected",
                      edgeId: null,
                      sourceNode: "n1",
                      targetNode: "n3",
                      tierBefore: null,
                      tierAfter: null,
                      reasoning: "Coincidence of timing, nothing more.",
                      confidence: 0.1,
                      createdAt: "2026-08-09T04:31:00.000Z",
                    },
                  ],
                  surfaced: [],
                },
              ],
              superseded: [node("old", "The old belief")],
            }),
          ),
    );
    renderMemory();

    const panel = await screen.findByTestId("dream-panel");

    expect(panel.textContent).toContain("A guess worth keeping");
    expect(panel.textContent).toContain("Coincidence of timing");
    expect(panel.textContent).toContain("The old belief");
  });

  it("should say a dream has never run rather than showing a blank panel", async () => {
    stubApi();
    renderMemory();

    const panel = await screen.findByTestId("dream-panel");

    expect(panel.textContent).toContain("No dream has ever run");
    expect(panel.textContent).toContain("correct answer rather than a missing one");
  });
});
