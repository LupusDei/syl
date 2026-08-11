import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApiError } from "@syl/shared";

import { createApp, type AppDependencies } from "../../src/index.js";
import {
  buildConstellation,
  DEFAULT_STARS,
  MAX_STARS,
  type ConstellationView,
} from "../../src/memory/constellation.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { crossingInstant, DEFAULT_WEIGHT_LAW, EdgeWeights } from "../../src/memory/weights.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { TEST_NOW, testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * The constellation — the graph shaped for a sky rather than for an instrument.
 *
 * What is being held here, and why each of them is a requirement:
 *
 * 1. **A paired phone can read it.** The Commander's ruling, 2026-08-10: he
 *    removed the second key from this whole surface because a view he needs a
 *    laptop to open is a view he does not open. A 403 here is a regression
 *    against a decision, not a tightening.
 * 2. **Brightness is the DECAYED weight, and it is a maximum.** A star is as
 *    bright as the strongest live thing touching it. A mean would let history
 *    dim a fact she is certain of, which is the opposite of what decay is for.
 * 3. **Nothing set aside is absent.** A hot edge to a cold node draws that node,
 *    dimmer and further back. That is constraint 6 rendered, and a `tier`
 *    predicate in the wrong place would quietly undo it.
 * 4. **The bound is exact and there is no total.** `mayHaveMore` is set at the
 *    moment a star is refused, never inferred from a full page — and the spec
 *    forbids a node count, so the payload must not carry one for a client to
 *    render.
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
let graph: MemoryGraph;
let weights: EdgeWeights;

const clock = fixedClock(TEST_NOW);

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  deviceToken = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  graph = new MemoryGraph({ db: db.handle, clock });
  weights = new EdgeWeights({ graph, clock });
});

afterEach(async () => {
  await running.close();
  db.close();
});

/** The assembly, against the same store the route reads. */
function build(stars = DEFAULT_STARS, now: number = TEST_NOW): ConstellationView {
  return buildConstellation({ graph, weights }, { stars }, now);
}

async function api(path: string, token: string = deviceToken): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    headers: token === "" ? {} : { authorization: `Bearer ${token}` },
  });
}

/** A person, a fact she was told, and the source that told her. */
function seedObserved(weight = 1): { person: string; fact: string; source: string; edge: string } {
  const person = graph.addNode({ kind: "person", label: "Sadie" });
  const fact = graph.addNode({ kind: "fact", label: "Runs the acquisition" });
  const source = graph.addNode({ kind: "source", label: "settings.json" });
  const edge = graph.observe({
    sourceNode: person.id,
    targetNode: fact.id,
    relation: "asserts",
    assertedBy: source.id,
    weight,
  });
  return { person: person.id, fact: fact.id, source: source.id, edge: edge.id };
}

/** A goal, an event, and the connection reflection drew between them. */
function seedInferred(
  weight = 0.8,
  reasoning = "They both slipped the same week.",
): { goal: string; event: string; edge: string } {
  const goal = graph.addNode({ kind: "goal", label: "Ship the memory viewer" });
  const event = graph.addNode({ kind: "event", label: "The dream that never ran" });
  const edge = graph.infer({
    sourceNode: goal.id,
    targetNode: event.id,
    relation: "blocked_by",
    reasoning,
    confidence: 0.7,
    weight,
    demoteAfter: crossingInstant(weight, TEST_NOW),
  });
  return { goal: goal.id, event: event.id, edge: edge.id };
}

describe("buildConstellation", () => {
  it("should draw a star for what she knows and a filament for what connects it", () => {
    const seeded = seedObserved();
    const sky = build();

    expect(sky.stars.map((star) => star.id).sort()).toEqual(
      [seeded.person, seeded.fact, seeded.source].sort(),
    );
    expect(sky.filaments).toHaveLength(1);
    expect(sky.filaments[0]?.id).toBe(seeded.edge);
    expect(sky.filaments[0]?.from).toBe(seeded.person);
    expect(sky.filaments[0]?.to).toBe(seeded.fact);
  });

  it("should make people and goals anchors and nothing else", () => {
    seedObserved();
    seedInferred();
    const sky = build();

    const anchors = sky.stars.filter((star) => star.anchor).map((star) => star.kind);
    const rest = sky.stars.filter((star) => !star.anchor).map((star) => star.kind);

    expect(anchors.sort()).toEqual(["goal", "person"]);
    expect(rest).not.toContain("person");
    expect(rest).not.toContain("goal");
  });

  it("should keep the two species apart so speculation never renders as assertion", () => {
    seedObserved();
    seedInferred();
    const sky = build();

    const observed = sky.filaments.find((filament) => filament.species === "observed");
    const inferred = sky.filaments.find((filament) => filament.species === "inferred");

    // WHO said so, and no invented certainty: a source simply said it.
    expect(observed?.assertedBy).not.toBeNull();
    expect(observed?.reasoning).toBeNull();
    expect(observed?.inferredConfidence).toBeNull();

    // WHY she believes it, and how sure reflection was — which does not decay.
    expect(inferred?.reasoning).toBe("They both slipped the same week.");
    expect(inferred?.inferredConfidence).toBe(0.7);
    expect(inferred?.assertedBy).toBeNull();
  });

  it("should name a source by its label, because an id is not something anyone can have an opinion about", () => {
    seedObserved();
    const sky = build();

    const fact = sky.stars.find((star) => star.kind === "fact");
    expect(fact?.provenance.species).toBe("observed");
    expect(fact?.provenance.assertedBy).toBe("settings.json");
  });

  it("should brighten a star to its STRONGEST live filament, not the average of them", () => {
    // The whole point of a maximum. A person she is certain about, with one
    // fresh connection and one nearly dead one, is a bright star — a mean would
    // let the dead one dim a thing she is sure of, which inverts what decay is
    // for.
    const person = graph.addNode({ kind: "person", label: "Sadie" });
    const strong = graph.addNode({ kind: "fact", label: "Runs the acquisition" });
    const faint = graph.addNode({ kind: "fact", label: "Mentioned a dog once" });
    const source = graph.addNode({ kind: "source", label: "settings.json" });
    graph.observe({
      sourceNode: person.id,
      targetNode: strong.id,
      relation: "asserts",
      assertedBy: source.id,
      weight: 1,
    });
    graph.observe({
      sourceNode: person.id,
      targetNode: faint.id,
      relation: "asserts",
      assertedBy: source.id,
      weight: 0.1,
    });

    const sky = build();
    const star = sky.stars.find((candidate) => candidate.id === person.id);

    expect(star?.confidence).toBeCloseTo(1, 10);
    // The mean of 1 and 0.1 is 0.55. If this ever passes at 0.55 the maximum
    // has become an average and every certain thing has gone dim.
    expect(star?.confidence).toBeGreaterThan(0.55);
  });

  it("should carry the story of the strongest filament, so brightness and provenance agree", () => {
    const person = graph.addNode({ kind: "person", label: "Sadie" });
    const fact = graph.addNode({ kind: "fact", label: "Runs the acquisition" });
    const source = graph.addNode({ kind: "source", label: "settings.json" });
    graph.observe({
      sourceNode: person.id,
      targetNode: fact.id,
      relation: "asserts",
      assertedBy: source.id,
      weight: 0.2,
    });
    graph.infer({
      sourceNode: person.id,
      targetNode: fact.id,
      relation: "reminds_me_of",
      reasoning: "The strongest thing she believes about this.",
      confidence: 0.9,
      weight: 1,
      demoteAfter: crossingInstant(1, TEST_NOW),
    });

    const star = build().stars.find((candidate) => candidate.id === fact.id);

    expect(star?.provenance.species).toBe("inferred");
    expect(star?.provenance.reasoning).toBe("The strongest thing she believes about this.");
  });

  it("should dim a star as the graph ages, without anything having been thrown out", () => {
    // Decay legible over time is the one thing this rendering says that no other
    // view of this data says. Same store, later instant, dimmer sky.
    seedObserved();
    const day = 24 * 60 * 60 * 1000;

    const now = build(DEFAULT_STARS, TEST_NOW);
    const later = build(DEFAULT_STARS, TEST_NOW + 60 * day);

    const before = now.stars.find((star) => star.kind === "fact")?.confidence ?? 0;
    const after = later.stars.find((star) => star.kind === "fact")?.confidence ?? 0;

    expect(after).toBeLessThan(before);
    // Approaches zero and never arrives. A literal zero would be an unrenderable
    // star and a memory that could never be promoted back.
    expect(after).toBeGreaterThan(0);
    expect(later.stars).toHaveLength(now.stars.length);
  });

  it("should give a star nothing connects to the faintest possible light rather than none", () => {
    graph.addNode({ kind: "person", label: "Somebody she has only just heard of" });
    const star = build().stars[0];

    expect(star?.confidence).toBe(DEFAULT_WEIGHT_LAW.minWeight);
    expect(star?.confidence).toBeGreaterThan(0);
    expect(star?.provenance.species).toBe("unattested");
    expect(star?.provenance.learnedAt).toBeNull();
  });

  it("should draw a cold node a hot edge reaches, dimmer and further back but never absent", () => {
    // Constraint 6, rendered. `neighbourhood` fetches endpoints by id, so the
    // tier of the far end is a depth and not a filter — and a `tier` predicate
    // added anywhere in this path would make set-aside memories silently vanish
    // from the sky while remaining perfectly present in the store.
    const seeded = seedObserved();
    const cold = graph.getNode(seeded.fact);
    graph.supersedeNode(cold as never);

    const sky = build();
    const star = sky.stars.find((candidate) => candidate.id === seeded.fact);

    expect(star).toBeDefined();
    expect(star?.tier).toBe("cold");
  });

  it("should never draw a filament with an end that is not in the sky", () => {
    // A line into nothing. Every filament's endpoints must be drawable, or the
    // client either drops it silently or draws off the edge of the world.
    //
    // The fixture is the whole test, and the first version of it was worthless:
    // a budget that cut cleanly between clusters can never produce a dangling
    // edge, so the assertion held with the guard deleted. The budget has to stop
    // the walk MID-ORBIT — one person, three facts, room for two stars — so that
    // a drawn star provably has hot edges reaching things that were left out.
    const person = graph.addNode({ kind: "person", label: "Sadie" });
    const source = graph.addNode({ kind: "source", label: "settings.json" });
    for (let index = 0; index < 3; index += 1) {
      const fact = graph.addNode({ kind: "fact", label: `Fact ${String(index)}` });
      graph.observe({
        sourceNode: person.id,
        targetNode: fact.id,
        relation: "asserts",
        assertedBy: source.id,
      });
    }

    const sky = build(2);
    const drawn = new Set(sky.stars.map((star) => star.id));

    // The fixture is doing what it claims: the sky is cut short, and the star
    // that IS drawn has more hot edges than the sky has room for.
    expect(sky.stars).toHaveLength(2);
    expect(sky.bound.mayHaveMore).toBe(true);
    expect(drawn.has(person.id)).toBe(true);
    expect(graph.neighbourhood(person.id, { depth: 1, tiers: ["hot"] }).edges).toHaveLength(3);

    expect(sky.filaments.length).toBeGreaterThan(0);
    for (const filament of sky.filaments) {
      expect(drawn.has(filament.from)).toBe(true);
      expect(drawn.has(filament.to)).toBe(true);
    }
  });

  it("should point every orbiting star at the anchor its strongest filament reaches", () => {
    const person = graph.addNode({ kind: "person", label: "Sadie" });
    const goal = graph.addNode({ kind: "goal", label: "Ship the memory viewer" });
    const fact = graph.addNode({ kind: "fact", label: "Runs the acquisition" });
    const source = graph.addNode({ kind: "source", label: "settings.json" });
    // Weaker to the goal, stronger to the person. It belongs to Sadie.
    graph.observe({
      sourceNode: goal.id,
      targetNode: fact.id,
      relation: "asserts",
      assertedBy: source.id,
      weight: 0.2,
    });
    graph.observe({
      sourceNode: person.id,
      targetNode: fact.id,
      relation: "asserts",
      assertedBy: source.id,
      weight: 0.95,
    });

    const sky = build();
    const star = sky.stars.find((candidate) => candidate.id === fact.id);
    const anchor = sky.stars.find((candidate) => candidate.id === person.id);

    expect(star?.anchor).toBe(false);
    expect(star?.anchorId).toBe(person.id);
    // An anchor orbits nothing, and the id it names is always an anchor.
    expect(anchor?.anchorId).toBeNull();
    expect(anchor?.anchor).toBe(true);
  });

  it("should say it may have more the moment a star is refused for want of budget", () => {
    for (let index = 0; index < 10; index += 1) {
      graph.addNode({ kind: "person", label: `Person ${String(index)}` });
    }

    const cramped = build(4);
    expect(cramped.stars).toHaveLength(4);
    expect(cramped.bound.mayHaveMore).toBe(true);
    expect(cramped.bound.starsReturned).toBe(4);
  });

  it("should say it may have more when the anchors fill the budget and other things exist", () => {
    // The under-reporting direction, and the one an optimisation reaches for
    // first: "the region is full, so skip the scan that would tell us what is
    // outside it". That leaves `mayHaveMore` reading false for a graph holding
    // plenty this sky does not show — the exact lie the flag exists to prevent,
    // arriving as a performance win.
    for (let index = 0; index < 3; index += 1) {
      graph.addNode({ kind: "person", label: `Person ${String(index)}` });
    }
    for (let index = 0; index < 5; index += 1) {
      graph.addNode({ kind: "fact", label: `Fact ${String(index)}` });
    }

    const sky = build(3);

    expect(sky.stars).toHaveLength(3);
    expect(sky.stars.every((star) => star.anchor)).toBe(true);
    expect(sky.bound.mayHaveMore).toBe(true);
  });

  it("should NOT say it may have more when the region ends exactly on the budget", () => {
    // The case a `starsReturned === stars` shortcut gets wrong, and the only
    // case where it differs: a full page that is also the whole region. Claiming
    // more sky than exists offers a way back to nothing.
    for (let index = 0; index < 4; index += 1) {
      graph.addNode({ kind: "person", label: `Person ${String(index)}` });
    }

    const exact = build(4);
    expect(exact.stars).toHaveLength(4);
    expect(exact.bound.stars).toBe(4);
    expect(exact.bound.mayHaveMore).toBe(false);
  });

  it("should say what it is in words, so a region is never read as the whole sky", () => {
    seedObserved();
    const sky = build();

    expect(sky.bound.explanation).toContain("NOT everything");
    expect(sky.bound.filamentsReturned).toBe(sky.filaments.length);
    expect(sky.bound.starsReturned).toBe(sky.stars.length);
  });

  it("should carry no total of anything the graph holds, because a count is a dashboard statistic", () => {
    // The spec forbids a node count on this screen. A total in the payload is an
    // invitation to render one, so the honest bound answers "is this all of it?"
    // without answering "how much is there?".
    seedObserved();
    const bound = build().bound as unknown as Record<string, unknown>;

    expect(Object.keys(bound).sort()).toEqual([
      "explanation",
      "filamentsReturned",
      "mayHaveMore",
      "stars",
      "starsReturned",
    ]);
  });

  it("should still draw a sky when there is not a single person or goal in the graph", () => {
    // Every graph on its first day. An empty sky is indistinguishable from a
    // broken one, so the region falls back to the most connected of what exists.
    const a = graph.addNode({ kind: "fact", label: "Prefers Central time" });
    const b = graph.addNode({ kind: "memory", label: "The night the dream did not run" });
    const source = graph.addNode({ kind: "source", label: "settings.json" });
    graph.observe({
      sourceNode: a.id,
      targetNode: b.id,
      relation: "asserts",
      assertedBy: source.id,
    });

    const sky = build();

    expect(sky.stars.length).toBe(3);
    expect(sky.stars.every((star) => !star.anchor)).toBe(true);
    expect(sky.filaments).toHaveLength(1);
  });
});

describe("GET /api/v1/memory/constellation", () => {
  it("should serve the phone, which is the only device this view is for", async () => {
    // The Commander's ruling, 2026-08-10: no second key for this surface. A 403
    // here is a regression against a decision he made in as many words.
    seedObserved();
    const response = await api("/memory/constellation");
    const payload = (await response.json()) as Envelope<ConstellationView>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.stars.length).toBeGreaterThan(0);
    expect(payload.data?.bound.stars).toBe(DEFAULT_STARS);
  });

  it("should give an anonymous caller the ordinary 401 and disclose no scope", async () => {
    const response = await api("/memory/constellation", "");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(401);
    expect(failure.error?.code).toBe("UNAUTHORIZED");
    expect(failure.error?.message.toLowerCase()).not.toContain("admin");
  });

  it("should refuse a star count beyond the bound rather than quietly clamping it", async () => {
    const response = await api(`/memory/constellation?stars=${String(MAX_STARS + 1)}`);
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.error?.code).toBe("VALIDATION_FAILED");
  });

  it("should honour a star count within the bound and report it back", async () => {
    seedObserved();
    const response = await api("/memory/constellation?stars=2");
    const payload = (await response.json()) as Envelope<ConstellationView>;

    expect(response.status).toBe(200);
    expect(payload.data?.bound.stars).toBe(2);
    expect(payload.data?.stars).toHaveLength(2);
    expect(payload.data?.bound.mayHaveMore).toBe(true);
  });
});
