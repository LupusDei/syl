import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiError } from "@syl/shared";

import { createApp, type AppDependencies } from "../../src/index.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { DreamLog } from "../../src/memory/dream/log.js";
import { crossingInstant, DEFAULT_WEIGHT_LAW } from "../../src/memory/weights.js";
import type {
  MemoryEdgeView,
  MemoryFeedbackResult,
  MemoryGraphView,
} from "../../src/routes/memory.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { TEST_NOW, testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * The memory routes — the admin's window onto the graph, and its correction
 * surface.
 *
 * Three things are being held here, and each of them is a requirement rather
 * than a nicety:
 *
 * 1. **The two species travel separately.** `observed` carries `assertedBy` and
 *    never `reasoning`; `inferred` carries `reasoning` and never `assertedBy`.
 *    A viewer that cannot tell them apart cannot judge the inferred engine,
 *    which is the whole reason the Commander asked for this.
 * 2. **This endpoint WRITES.** Reject and confirm feed the suppression and
 *    trust forces in `weights.ts`, so the route is a data source for the memory
 *    system and not merely a window onto it.
 * 3. **It is NOT admin-scoped, and this line used to say the opposite.** It said
 *    a paired phone is refused, because the graph is the record of what a
 *    pre-authorised program inferred on his machine and the correction surface
 *    writes into her memory. The Commander overruled that on 2026-08-10 —
 *    *"remove the need for another key for the admin panel, too annoying"* — and
 *    the three cases below asserting a device gets `200` are the record of it.
 *    Authentication is still required and is what does the work.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let deviceToken: string;
let adminToken: string;
let graph: MemoryGraph;
let dreams: DreamLog;

const clock = fixedClock(TEST_NOW);

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  deviceToken = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  adminToken = deps.keys.mint("Web admin (console)", { scope: "admin" }).token;
  graph = new MemoryGraph({ db: db.handle, clock });
  dreams = new DreamLog({ db: db.handle, clock });
});

afterEach(async () => {
  await running.close();
  db.close();
});

async function api(path: string, token: string = adminToken, init: RequestInit = {}): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
      ...(init.headers ?? {}),
    },
  });
}

async function body<T>(path: string, token?: string): Promise<Envelope<T>> {
  return (await (await api(path, token)).json()) as Envelope<T>;
}

/** POST a verdict with a fresh idempotency key. */
async function verdict(
  edgeId: string,
  value: string,
  options: { readonly token?: string; readonly key?: string } = {},
): Promise<Response> {
  return api(`/memory/edges/${encodeURIComponent(edgeId)}/feedback`, options.token ?? adminToken, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": options.key ?? `key-${String(Math.random())}`,
    },
    body: JSON.stringify({ verdict: value }),
  });
}

/** Two nodes and one inferred edge between them, at full strength. */
function seedInferred(reasoning = "They both slipped the same week."): {
  readonly edgeId: string;
  readonly sourceId: string;
  readonly targetId: string;
} {
  const source = graph.addNode({ kind: "goal", label: "Ship the memory viewer" });
  const target = graph.addNode({ kind: "event", label: "The dream that never ran" });
  const edge = graph.infer({
    sourceNode: source.id,
    targetNode: target.id,
    relation: "blocked_by",
    reasoning,
    confidence: 0.7,
    weight: 0.8,
    demoteAfter: crossingInstant(0.8, TEST_NOW),
  });
  return { edgeId: edge.id, sourceId: source.id, targetId: target.id };
}

/** One observed edge, asserted by a source node. */
function seedObserved(): { readonly edgeId: string } {
  const source = graph.addNode({ kind: "person", label: "The Commander" });
  const target = graph.addNode({ kind: "fact", label: "Prefers Central time" });
  const asserter = graph.addNode({ kind: "source", label: "settings.json" });
  const edge = graph.observe({
    sourceNode: source.id,
    targetNode: target.id,
    relation: "asserts",
    assertedBy: asserter.id,
  });
  return { edgeId: edge.id };
}

function edgeOf(view: MemoryGraphView, id: string): MemoryEdgeView | undefined {
  return view.edges.find((edge) => edge.id === id);
}

describe("GET /api/v1/memory/graph", () => {
  it("should answer an empty store with a shape rather than a failure", async () => {
    // The state he will actually see first: no dream has ever run. "Nothing
    // here yet" and "this is broken" must not look alike, and the flag that
    // separates them cannot be derived from an empty array.
    const response = await api("/memory/graph");
    const page = (await response.json()) as Envelope<MemoryGraphView>;

    expect(response.status).toBe(200);
    expect(page.success).toBe(true);
    expect(page.data?.nodes).toEqual([]);
    expect(page.data?.edges).toEqual([]);
    expect(page.data?.nights).toEqual([]);
    expect(page.data?.scope.dreamHasEverRun).toBe(false);
  });

  it("should carry the reasoning on an inferred edge and provenance on an observed one", async () => {
    // The species distinction, at the wire. An inferred edge without its
    // reasoning cannot be judged, and an observed edge with a `reasoning`
    // field would invite a viewer to render the two the same way.
    const inferred = seedInferred("Both were blocked on the same missing migration.");
    const observed = seedObserved();

    const page = await body<MemoryGraphView>("/memory/graph");
    const one = edgeOf(page.data as MemoryGraphView, inferred.edgeId);
    const two = edgeOf(page.data as MemoryGraphView, observed.edgeId);

    expect(one?.kind).toBe("inferred");
    expect(one?.reasoning).toBe("Both were blocked on the same missing migration.");
    expect(one?.assertedBy).toBeNull();
    expect(one?.confidence).toBeCloseTo(0.7);

    expect(two?.kind).toBe("observed");
    expect(two?.reasoning).toBeNull();
    expect(two?.assertedBy).not.toBeNull();
  });

  it("should serve the DECAYED weight beside the stored one, so the curve is visible", async () => {
    // The stored weight is what was last written; the decayed one is what the
    // edge is actually worth today. A viewer given only the first draws a
    // graph of six-month-old certainties that look current.
    seedInferred();

    const page = await body<MemoryGraphView>("/memory/graph");
    const edge = page.data?.edges[0];

    expect(edge?.storedWeight).toBeCloseTo(0.8);
    expect(edge?.effectiveWeight).toBeGreaterThan(0);
    expect(edge?.effectiveWeight).toBeLessThanOrEqual(0.8);
    expect(page.data?.law.relevanceFloor).toBeCloseTo(DEFAULT_WEIGHT_LAW.relevanceFloor);
  });

  it("should include an edge the dream touched even after it has left the hot tier", async () => {
    // The hot region alone would hide exactly what he wants to look at: the
    // connection last night created and the sweep has already demoted.
    const seeded = seedInferred();
    const session = dreams.openSession({ night: "2026-08-09", tz: "America/Chicago", tokenCeiling: 1_000 });
    dreams.recordReasoning({
      sessionId: session.id,
      disposition: "created",
      edgeId: seeded.edgeId,
      sourceNode: seeded.sourceId,
      targetNode: seeded.targetId,
      reasoning: "A guess worth keeping.",
      confidence: 0.7,
    });
    graph.demote(graph.getEdge(seeded.edgeId) as never);

    const page = await body<MemoryGraphView>("/memory/graph");

    expect(edgeOf(page.data as MemoryGraphView, seeded.edgeId)?.tier).toBe("cold");
    expect(page.data?.nights).toHaveLength(1);
    expect(page.data?.nights[0]?.dispositions[0]?.disposition).toBe("created");
    expect(page.data?.scope.dreamHasEverRun).toBe(true);
  });

  it("should say what it left out rather than presenting a slice as the whole store", async () => {
    // Scale: this view is the hot region plus the last N nights, never the
    // whole graph. Silence about that turns a deliberate scope into a
    // believable lie.
    seedInferred();

    const page = await body<MemoryGraphView>("/memory/graph?edges=1");

    expect(page.data?.scope.edgeBudget).toBe(1);
    expect(page.data?.scope.explanation).toMatch(/hot/i);
  });

  it("should refuse a nights window that is not a positive whole number", async () => {
    const response = await api("/memory/graph?nights=0");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.success).toBe(false);
    expect(failure.error?.code).toBe("VALIDATION_FAILED");
  });

  it("should serve a paired device, which is the whole point of the view", async () => {
    // RESTATED by the Commander, 2026-08-10. Inverted rather than deleted: the
    // old assertion recorded a real decision and this records the one that
    // replaced it. He asked for this view specifically so he could judge
    // whether the inferred engine is any good, and a view that needs a
    // console-minted key pasted into a phone is a view he does not open.
    const response = await api("/memory/graph", deviceToken);

    expect(response.status).toBe(200);
  });

  it("should give an anonymous caller the ordinary 401 and disclose no scope", async () => {
    const response = await api("/memory/graph", "");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(401);
    expect(failure.error?.code).toBe("UNAUTHORIZED");
    expect(failure.error?.message.toLowerCase()).not.toContain("admin");
  });
});

describe("GET /api/v1/memory/metrics", () => {
  it("should report the invariant as unproven when no dream has ever inserted an edge", async () => {
    // Zero breaches out of zero attempts is an absence of evidence. It must
    // never arrive at the viewer wearing `holds`.
    const page = await body<{
      alarm: { status: string; severity: string; headline: string };
      survival: { overall: { value: number | null; undefinedBecause: string | null } };
    }>("/memory/metrics");

    expect(page.data?.alarm.status).toBe("unproven");
    expect(page.data?.alarm.severity).toBe("unknown");
    expect(page.data?.survival.overall.value).toBeNull();
    expect(page.data?.survival.overall.undefinedBecause).toContain("not a rate of zero");
  });

  it("should carry the cold sample with its reasoning, which is the only thing he can judge", async () => {
    // `syl-005.6.4` acceptance, in the Commander's words: "a cold sample he can
    // eyeball — periodically surface a random handful of cold edges with their
    // reasoning IN THE ADMIN. Metrics tell us whether the machinery works; only
    // he can tell us whether anything valuable is down there."
    const seeded = seedInferred("Both were about promises the system could not keep.");
    graph.demote(graph.getEdge(seeded.edgeId) as never);

    const page = await body<{
      cold: {
        shape: { edges: number; inferred: number; timeInCold: unknown };
        sample: { id: string; reasoning: string; sourceLabel: string; targetLabel: string }[];
      };
    }>("/memory/metrics");

    expect(page.data?.cold.shape.edges).toBe(1);
    expect(page.data?.cold.sample).toHaveLength(1);
    expect(page.data?.cold.sample[0]?.reasoning).toBe(
      "Both were about promises the system could not keep.",
    );
    // Endpoint labels, not ids: an id is not something anyone can have an
    // opinion about.
    expect(page.data?.cold.sample[0]?.sourceLabel).toBe("Ship the memory viewer");
    expect(page.data?.cold.sample[0]?.targetLabel).toBe("The dream that never ran");
  });

  it("should report no time-in-cold distribution as null rather than as zeroes", async () => {
    // Nothing is cold, so there is no distribution — which is a different fact
    // from a distribution of zeroes, and they render identically otherwise.
    const page = await body<{
      cold: { shape: { edges: number; timeInCold: unknown; oldestAgeMs: number | null } };
    }>("/memory/metrics");

    expect(page.data?.cold.shape.edges).toBe(0);
    expect(page.data?.cold.shape.timeInCold).toBeNull();
    expect(page.data?.cold.shape.oldestAgeMs).toBeNull();
  });

  it("should serve a paired device, same as the graph it describes", async () => {
    // Same ruling. The metrics are the numbers under the picture — gating them
    // separately would leave him a graph he can see and a legend he cannot.
    const response = await api("/memory/metrics", deviceToken);

    expect(response.status).toBe(200);
  });
});

describe("POST /api/v1/memory/edges/:edgeId/feedback", () => {
  it("should lift an edge the Commander confirms, by more than her own traversal could", async () => {
    const seeded = seedInferred();

    const response = await verdict(seeded.edgeId, "confirm");
    const result = (await response.json()) as Envelope<MemoryFeedbackResult>;

    expect(response.status).toBe(200);
    expect(result.data?.edge.tier).toBe("hot");
    // Engagement reaches above the internal traversal cap; nothing else does.
    expect(result.data?.edge.storedWeight).toBeGreaterThan(DEFAULT_WEIGHT_LAW.touch.traversal.cap);
    expect(result.data?.weightBefore).toBeLessThan(result.data?.weightAfter as number);
  });

  it("should suppress an edge the Commander rejects and drop it below the floor", async () => {
    // Suppression is a tier, not merely a weight: the edge leaves every scan,
    // and the penalty is what makes a later un-suppression return something
    // dormant rather than something live.
    const seeded = seedInferred();

    const response = await verdict(seeded.edgeId, "reject");
    const result = (await response.json()) as Envelope<MemoryFeedbackResult>;

    expect(response.status).toBe(200);
    expect(result.data?.edge.tier).toBe("suppressed");
    expect(result.data?.edge.storedWeight).toBeLessThan(DEFAULT_WEIGHT_LAW.relevanceFloor);
  });

  it("should answer a verdict it does not know with a structured refusal", async () => {
    const seeded = seedInferred();

    const response = await verdict(seeded.edgeId, "maybe");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.success).toBe(false);
    expect(failure.error?.code).toBe("VALIDATION_FAILED");
    expect(failure.error?.details?.["field"]).toBe("verdict");
  });

  it("should answer an unknown edge with NOT_FOUND rather than a silent success", async () => {
    const response = await verdict("syl:medge:missing", "reject");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(404);
    expect(failure.error?.code).toBe("NOT_FOUND");
  });

  it("should refuse to confirm something he has already rejected", async () => {
    // He said no once. Neither Syl's retrieval nor a stray click gets to
    // overrule that implicitly.
    const seeded = seedInferred();
    await verdict(seeded.edgeId, "reject");

    const response = await verdict(seeded.edgeId, "confirm");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(409);
    expect(failure.error?.code).toBe("CONFLICT");
  });

  it("should require an idempotency key, like every other write in the contract", async () => {
    const seeded = seedInferred();

    const response = await api(`/memory/edges/${encodeURIComponent(seeded.edgeId)}/feedback`, adminToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "reject" }),
    });
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("should answer a replayed key with the stored result rather than rejecting twice", async () => {
    const seeded = seedInferred();

    const first = await verdict(seeded.edgeId, "reject", { key: "same-key" });
    const second = await verdict(seeded.edgeId, "reject", { key: "same-key" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("should record the verdict against what she surfaced, so engagement stops being blind", async () => {
    // The engagement metric's denominator only moves if the answer is written
    // back to the dream log. Without this the panel reports "everything
    // surfaced is still awaiting a verdict" forever.
    const seeded = seedInferred();
    const session = dreams.openSession({ night: "2026-08-09", tz: "America/Chicago", tokenCeiling: 1_000 });
    dreams.recordSurfaced({
      sessionId: session.id,
      edgeId: seeded.edgeId,
      summary: "These two look connected.",
    });

    const response = await verdict(seeded.edgeId, "reject");
    const result = (await response.json()) as Envelope<MemoryFeedbackResult>;

    expect(result.data?.surfacedRecorded).toBe(1);
    expect(dreams.surfacedOf(session.id)[0]?.response).toBe("rejected");
  });

  it("should let a paired device correct an edge, which is where he will be when he spots one", async () => {
    // The write, and the one I would have argued to keep behind admin: killing
    // an edge changes what Syl believes. He ruled otherwise and the reasoning
    // holds — confirming a wrong inference is only useful at the moment he
    // notices it, and he notices it on the phone. An edge is demoted rather
    // than destroyed (constraint 6), so a mis-tap costs relevance, not a fact.
    const seeded = seedInferred();

    const response = await verdict(seeded.edgeId, "reject", { token: deviceToken });

    expect(response.status).toBe(200);
  });
});
