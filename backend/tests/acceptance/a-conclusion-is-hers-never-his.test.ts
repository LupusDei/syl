import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HealthSamples } from "../../src/health/samples.js";
import { HealthReview } from "../../src/health/review.js";
import { DreamLog } from "../../src/memory/dream/log.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { HerOwnMemory } from "../../src/memory/remember.js";
import { fixedClock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";
import { loadFixture, makeFakeClaude, type FakeClaude } from "../helpers/fake-claude.js";

import type { AuthorisationState, HealthSampleInput, HealthType } from "../../src/health/contract.js";
import { HEALTH_TYPES } from "../../src/health/contract.js";

/**
 * **`syl-t9tj.4.4` (T017) — a conclusion is HERS, never HIS.**
 *
 * > After a real review, over real measurements, through the real store and the
 * > real `remember()`: every node the review path created is `kind: "memory"`,
 * > every one carries reasoning that names the window it was drawn from, and
 * > **no `fact` node exists anywhere.**
 *
 * ## The one failure in this subsystem that would corrupt what she believes
 *
 * `EXTRACTION_INSTRUCTION` criterion 3 — *"HE asserted it. Not something Syl
 * offered, guessed or worked out"* — is what stops her fabricating facts about
 * the Commander. `kind: "fact"` is the shape that claim takes on disk, and it
 * is what `extract-apply.ts` writes from **his own words**.
 *
 * He said nothing here. A sensor produced numbers and she did arithmetic over
 * them. A conclusion filed as a `fact` would be Syl asserting, in his voice,
 * something he never said — and unlike a wrong conclusion, which he can read
 * and kill, a wrongly-*attributed* one is invisible: it looks exactly like
 * something he told her last month and forgot.
 *
 * ## Measured on the shape, not on the source
 *
 * The assertion is deliberately not "review.ts never passes `kind`". That would
 * be green while a future edit routed one conclusion through a different verb.
 * What is measured is what SQLite actually holds after a real review:
 *
 *  1. Seed the graph the way anything else seeds it, including a `fact` he
 *     really did assert — so "no fact was created" is a delta rather than a
 *     vacuous zero.
 *  2. Upload two weeks of measurements into the real observation store.
 *  3. Run the real `HealthReview` against a real `claude` subprocess (a fake
 *     binary replaying a captured `--tools ""` transcript) whose reply is a
 *     well-formed set of conclusions.
 *  4. Ask the database what it has.
 *
 * ## And the reasoning names its window
 *
 * US3's acceptance criterion. It is asserted on the EDGE, because that is where
 * an inference's reasoning lives and where `memory_provenance` deliberately
 * cannot reach — see the header of `memory/remember.ts` for why a conclusion
 * from fourteen nights has no `said_in`, no digest and no quote to copy.
 */

const CHICAGO = "America/Chicago";
/** 13 August 2026, 03:00 in his zone — the hour the dream runs. */
const NOW = Date.UTC(2026, 7, 13, 8, 0, 0, 0);
const DAY_MS = 24 * 60 * 60_000;

let database: SylDatabase;
let graph: MemoryGraph;
let log: DreamLog;
let hers: HerOwnMemory;
let samples: HealthSamples;
let fakes: FakeClaude[];

beforeEach(() => {
  database = openDatabase({ path: IN_MEMORY });
  const clock = fixedClock(NOW);
  graph = new MemoryGraph({ db: database.handle, clock });
  log = new DreamLog({ db: database.handle, clock });
  hers = new HerOwnMemory({ db: database.handle, graph, clock });
  samples = new HealthSamples({ db: database.handle, clock });
  fakes = [];
});

afterEach(() => {
  for (const fake of fakes) fake.cleanup();
  database.close();
});

function fullReport(): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

/**
 * Two weeks of sleep and steps, ending yesterday.
 *
 * Shaped so there IS something to notice — the last four nights are short —
 * because a test whose input says nothing cannot tell "she concluded nothing"
 * from "she cannot conclude anything".
 */
function twoWeeks(): HealthSampleInput[] {
  const out: HealthSampleInput[] = [];
  for (let back = 14; back >= 1; back -= 1) {
    const midnight = NOW - back * DAY_MS;
    const shortNight = back <= 4;
    out.push({
      type: "sleep",
      startedAt: new Date(midnight).toISOString(),
      endedAt: new Date(midnight + 6 * 3_600_000).toISOString(),
      value: shortNight ? 291 : 437,
      source: "Oura",
    });
    out.push({
      type: "steps",
      startedAt: new Date(midnight + 12 * 3_600_000).toISOString(),
      endedAt: new Date(midnight + 13 * 3_600_000).toISOString(),
      value: 8_400 - back * 30,
      source: "iPhone",
    });
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(midnight + hour * 3_600_000).toISOString();
      out.push({
        type: "heartRate",
        startedAt: at,
        endedAt: at,
        // A low overnight floor, higher through the day, and the last four days
        // sit a few beats above the rest.
        value: (hour < 6 ? 52 : 68) + (shortNight ? 5 : 0) + (hour % 3),
        source: "Apple Watch",
      });
    }
  }
  return out;
}

/** What a well-behaved review turn replies. */
const REPLY = JSON.stringify({
  conclusions: [
    {
      thought:
        "His sleep has dropped to about 4h50m a night for the last four nights, against " +
        "roughly 7h20m over the ten before that.",
      because: "Four consecutive nights sit below his own baseline by more than two hours.",
      about: ["Amanda"],
      tell_him: true,
    },
    {
      thought: "His overnight heart-rate floor has run five beats above his usual for four days.",
      because:
        "The quiet floor I estimate from raw heart rate is 57 for the last four days against 52 before.",
      tell_him: false,
    },
  ],
});

/**
 * A captured transcript with the assistant's reply swapped for a payload.
 *
 * `reader-direct` because it is the capture of THIS shape — a real turn spawned
 * with `--tools ""` whose init frame reports `"tools":[]`. A review turn
 * refuses to run against a live tool surface, which is the point, so a
 * transcript captured with thirty tools would be the wrong evidence.
 */
function transcriptSaying(payload: string): string[] {
  return loadFixture("reader-direct").map((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (frame["type"] === "result") {
      frame["result"] = payload;
      frame["usage"] = {
        input_tokens: 900,
        output_tokens: 120,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
    }
    return JSON.stringify(frame);
  });
}

/** The graph as it stands before any health review — including a real fact of his. */
function seedTheGraph(): { factId: string; wifeId: string } {
  const wife = graph.addNode({ kind: "person", label: "Amanda" });
  const fact = graph.addNode({
    kind: "fact",
    label: "He is training for a half marathon in October",
    body: "He said so on 2 August.",
  });
  graph.addNode({ kind: "goal", label: "Get back to 185 pounds" });
  return { factId: fact.id, wifeId: wife.id };
}

function nodesOfKind(kind: string): { id: string; label: string; body: string | null }[] {
  return database.handle
    .prepare("SELECT id, label, body FROM memory_nodes WHERE kind = ? ORDER BY id")
    .all(kind)
    .map((row) => row as unknown as { id: string; label: string; body: string | null });
}

async function reviewOnce(reply = REPLY): Promise<void> {
  const fake = makeFakeClaude({ after: transcriptSaying(reply) });
  fakes.push(fake);

  samples.append({ samples: twoWeeks(), authorisation: fullReport() });

  const review = new HealthReview({
    samples,
    hers,
    log,
    tz: CHICAGO,
    clock: fixedClock(NOW),
    entities: () => ["Amanda", "Get back to 185 pounds"],
    turnOptions: { claudeBin: fake.bin },
  });

  const session = log.openSession({ tz: CHICAGO, tokenCeiling: 1_000_000, night: "2026-08-12" });
  const report = await review.run(session.id);
  expect(report.error).toBeNull();
  expect(report.ran).toBe(true);
}

describe("a conclusion is hers, never his", () => {
  it("should file every conclusion as kind memory and create no fact at all", async () => {
    const { factId } = seedTheGraph();
    const factsBefore = nodesOfKind("fact");
    expect(factsBefore).toHaveLength(1);

    await reviewOnce();

    const memories = nodesOfKind("memory");
    expect(memories).toHaveLength(2);
    expect(memories.map((node) => node.body)).toEqual(
      expect.arrayContaining([expect.stringContaining("4h50m")]),
    );

    // The delta, not a vacuous zero: the one fact in the graph is the one HE
    // asserted, and the review path added none.
    const factsAfter = nodesOfKind("fact");
    expect(factsAfter).toHaveLength(1);
    expect(factsAfter[0]?.id).toBe(factId);

    // And nothing landed under any other kind either. A conclusion filed as a
    // `decision` or an `event` would evade a test that only counted facts.
    const kinds = database.handle
      .prepare("SELECT kind, count(*) AS n FROM memory_nodes GROUP BY kind ORDER BY kind")
      .all()
      .map((row) => row as unknown as { kind: string; n: number });
    expect(kinds).toEqual([
      { kind: "fact", n: 1 },
      { kind: "goal", n: 1 },
      { kind: "memory", n: 2 },
      { kind: "person", n: 1 },
    ]);
  });

  it("should carry reasoning that names the window it was drawn from", async () => {
    seedTheGraph();
    await reviewOnce();

    const edges = database.handle
      .prepare(
        `SELECT e.reasoning AS reasoning, e.kind AS species
           FROM memory_edges e JOIN memory_nodes n ON n.id = e.source_node
          WHERE n.kind = 'memory'`,
      )
      .all()
      .map((row) => row as unknown as { reasoning: string | null; species: string });

    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      // `inferred`, never `observed`: `observed` carries `assertedBy`, which is
      // precisely the claim that somebody said so. She may not produce one.
      expect(edge.species).toBe("inferred");
      expect(edge.reasoning).not.toBeNull();
      // The window, named: how many days, which days, and whose clock they are.
      expect(edge.reasoning).toContain("days of measurement");
      expect(edge.reasoning).toContain("August 2026");
      expect(edge.reasoning).toContain(CHICAGO);
    }
  });

  /**
   * **RED — `syl-1ozc`.** Correct behaviour, not current behaviour.
   *
   * `remember()` puts her reasoning on the inferred EDGE, which is right and is
   * argued in that file's header. But an edge needs a target, and `about`
   * resolves against entities that already exist and mints nothing — so a
   * memory that names nobody has no edges at all, and `because` is validated
   * non-blank and then never written anywhere.
   *
   * Health is the first class of memory that is routinely about NOBODY.
   * *"Your sleep has been short for five nights"* names no person, no goal and
   * no place. What was a corner case for `syl-016.7` is the common case here,
   * and US3's criterion — *every* conclusion carries reasoning naming its
   * window — is silently false for all of them.
   *
   * `health/review.ts` deliberately does not work around it. Every workaround
   * available inside the review is worse than the gap: putting the window into
   * the THOUGHT writes machine text into the sentence he reads; inventing an
   * anchor entity guesses at a label nothing marks; and discarding a conclusion
   * that names nothing is a bar at the door on a new axis, against his ruling.
   * The fix is a decision about the graph, so it is filed against the graph.
   */
  it("should keep its reasoning even when it names nothing she already knows", async () => {
    seedTheGraph();

    const fake = makeFakeClaude({
      after: transcriptSaying(
        JSON.stringify({
          conclusions: [
            {
              thought: "His sleep has been about 4h50m for four nights running.",
              because: "Four consecutive nights sit two hours below his own baseline.",
              // No `about`. Nothing in his graph is what this is about — it is
              // about his body, and his body is not a node.
            },
          ],
        }),
      ),
    });
    fakes.push(fake);

    samples.append({ samples: twoWeeks(), authorisation: fullReport() });
    const review = new HealthReview({
      samples,
      hers,
      log,
      tz: CHICAGO,
      clock: fixedClock(NOW),
      turnOptions: { claudeBin: fake.bin },
    });
    const session = log.openSession({ tz: CHICAGO, tokenCeiling: 1_000_000, night: "2026-08-12" });
    await review.run(session.id);

    const memories = nodesOfKind("memory");
    expect(memories).toHaveLength(1);
    const nodeId = memories[0]?.id ?? "";

    // Somewhere — on an edge, on the node, anywhere a reader can reach it —
    // this conclusion must be able to say why she believes it and over what.
    // Without that he can only accept or reject the whole thought, and the
    // correction that matters, that she reasoned wrongly from something true,
    // is one he cannot make.
    const reasons = database.handle
      .prepare(
        `SELECT reasoning FROM memory_edges
          WHERE source_node = ? OR target_node = ?`,
      )
      .all(nodeId, nodeId)
      .map((row) => (row as unknown as { reasoning: string | null }).reasoning);

    expect(reasons.filter((reason) => reason !== null)).toHaveLength(1);
    expect(reasons[0]).toContain("days of measurement");
  });

  it("should never write a conclusion as words the Commander asserted", async () => {
    seedTheGraph();
    await reviewOnce();

    // `memory_provenance` is the record of what HE said: it requires a digest,
    // a `said_in` message and a quote copied from that message. A conclusion
    // from fourteen nights has none of the three, and inventing them is the
    // fabricated provenance that table exists to make impossible.
    const provenance = database.handle
      .prepare("SELECT count(*) AS n FROM memory_provenance")
      .get();
    expect(Number((provenance as unknown as { n: number }).n)).toBe(0);

    // Nor may she have claimed an assertion on an edge.
    const asserted = database.handle
      .prepare(
        `SELECT count(*) AS n FROM memory_edges e JOIN memory_nodes n ON n.id = e.source_node
          WHERE n.kind = 'memory' AND e.asserted_by IS NOT NULL`,
      )
      .get();
    expect(Number((asserted as unknown as { n: number }).n)).toBe(0);
  });

  it("should discard the whole reply rather than apply the half of it that parsed", async () => {
    seedTheGraph();

    // One good conclusion and one with nothing to say. The good one is not
    // written: these land in the document she reads every turn, and a
    // partially-applied review leaves him a subset nobody chose.
    const fake = makeFakeClaude({
      after: transcriptSaying(
        JSON.stringify({
          conclusions: [
            { thought: "His sleep is short.", because: "Four nights under his baseline." },
            { thought: "   ", because: "" },
          ],
        }),
      ),
    });
    fakes.push(fake);

    samples.append({ samples: twoWeeks(), authorisation: fullReport() });
    const review = new HealthReview({
      samples,
      hers,
      log,
      tz: CHICAGO,
      clock: fixedClock(NOW),
      turnOptions: { claudeBin: fake.bin },
    });
    const session = log.openSession({ tz: CHICAGO, tokenCeiling: 1_000_000, night: "2026-08-12" });
    const report = await review.run(session.id);

    expect(report.error).toContain("discarded");
    expect(nodesOfKind("memory")).toHaveLength(0);
  });
});
