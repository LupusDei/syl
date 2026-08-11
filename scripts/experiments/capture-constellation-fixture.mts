import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryGraph } from "../../backend/src/memory/graph.js";
import { crossingInstant } from "../../backend/src/memory/weights.js";
import { startLiveService } from "../../backend/tests/helpers/live-service.js";

/**
 * Capture the constellation fixture from the RUNNING service.
 *
 * Not hand-written from `shared/src/types.ts`: the point of a fixture is to
 * catch drift between our types and what actually goes on the wire, and a
 * fixture authored from the types cannot ever disagree with them. Modelled on
 * `capture-attachment-fixtures.mts`, which is the same argument.
 *
 *     npx tsx scripts/experiments/capture-constellation-fixture.mts
 *
 * Re-run it after any change to the constellation payload, and commit what it
 * writes — including the ids and instants, which are the service's own and are
 * what make the file evidence rather than an illustration.
 *
 * ## What is seeded, and why each piece is there
 *
 * The fixture has to exercise every branch of the payload, because the Swift
 * contract suite round-trips it and a `null` that never appears is a
 * `CodingKeys` bug nobody catches:
 *
 *   - an **observed** filament, so `assertedBy` is non-null and
 *     `inferredConfidence` and `reasoning` are null;
 *   - an **inferred** filament, so the opposite three;
 *   - a **cold** star reached by a hot filament, so tier is exercised as depth
 *     rather than as a filter — the constraint-6 case;
 *   - an **unattested** star nothing connects to, so `provenance.learnedAt` and
 *     `anchorId` are null and `confidence` is the law's floor;
 *   - two anchor kinds, a person and a goal, so `anchor` is both values.
 *
 * The device token is obtained by **pairing over HTTP**, exactly as the phone
 * does, so the capture also demonstrates the thing this whole bead is about:
 * this route answers a `device` key.
 */

const FIXTURES = fileURLToPath(new URL("../../shared/fixtures", import.meta.url));

function write(name: string, body: unknown): void {
  writeFileSync(join(FIXTURES, name), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${name}`);
}

const syl = await startLiveService();
try {
  const now = Date.now();
  const graph = new MemoryGraph({ db: syl.database.handle, clock: () => now });

  const commander = graph.addNode({ kind: "person", label: "The Commander" });
  const goal = graph.addNode({ kind: "goal", label: "Ship the constellation" });
  const source = graph.addNode({ kind: "source", label: "settings.json" });
  const fact = graph.addNode({ kind: "fact", label: "Prefers Central time" });
  const event = graph.addNode({ kind: "event", label: "The dream that never ran" });
  const older = graph.addNode({ kind: "memory", label: "A memory since set aside" });

  // Observed: a source said so.
  graph.observe({
    sourceNode: commander.id,
    targetNode: fact.id,
    relation: "asserts",
    assertedBy: source.id,
    weight: 1,
  });

  // Inferred: she worked it out, and can say why.
  graph.infer({
    sourceNode: goal.id,
    targetNode: event.id,
    relation: "blocked_by",
    reasoning: "They both slipped the same week, and the second explains the first.",
    confidence: 0.7,
    weight: 0.8,
    demoteAfter: crossingInstant(0.8, now),
  });

  // A hot filament reaching a node that has since been set aside. Drawn dimmer
  // and further back — never absent. This is the constraint-6 case.
  graph.observe({
    sourceNode: commander.id,
    targetNode: older.id,
    relation: "remembers",
    assertedBy: source.id,
    weight: 0.4,
  });
  graph.supersedeNode(graph.getNode(older.id) as never);

  // Nothing connects to this one.
  graph.addNode({ kind: "decision", label: "Something she has only just heard of" });

  const response = await syl.api("/memory/constellation?stars=12");
  const body = (await response.json()) as { success?: boolean; data?: unknown };
  if (response.status !== 200) throw new Error(JSON.stringify(body));

  write("http/memory.constellation.json", body);
} finally {
  await syl.close();
}
