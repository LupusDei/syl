import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEALTH_TYPES,
  type AuthorisationState,
  type HealthSampleInput,
  type HealthType,
} from "../../src/health/contract.js";
import { createApp, type AppDependencies } from "../../src/index.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * **`syl-t9tj.2.5` (T009) — a health sample cannot become a memory node.**
 *
 * > After a real upload, through the real route, into the real store: the memory
 * > graph has not grown, no node of any kind carries a sample's identity, and
 * > the document Syl reads every turn is byte-for-byte what it was.
 *
 * ## The test this whole epic's structure exists to satisfy
 *
 * The live memory graph holds about **thirty nodes**. One week of HealthKit
 * samples is **tens of thousands**. Salience ranks over incident edge weight and
 * node kind, so dropping 50,000 measurements into the graph destroys every
 * ranking the working-memory projection depends on. **His wife would be evicted
 * by his step count.**
 *
 * That is not a hypothetical. `syl-ulf` already did it once, by a different
 * door: the Commander's own name, his wife, his son and his daughter dropped out
 * of the document she reads every turn, and **it was invisible until somebody
 * measured the live graph instead of reading the code.** Every unit test passed.
 * The projection regenerated successfully. The only symptom was that Syl stopped
 * knowing who she was talking about.
 *
 * ## So this measures the shape, not the source
 *
 * The assertion is deliberately not "no module imports the graph" or "the SQL
 * contains no join". Both would have been green during `syl-ulf`. What is
 * measured here is what the database actually holds after real work:
 *
 *  1. Seed the four people `syl-ulf` evicted, and regenerate the projection.
 *  2. Upload **two thousand** measurements over HTTP, exactly as the phone
 *     does — real route, real validation, real store, real transaction.
 *  3. Ask SQLite what it has.
 *
 * Two thousand samples against a handful of nodes. If there were any path at all
 * from a measurement into the graph, the node count would not drift — it would
 * detonate, and the projection would come back full of heart rates.
 *
 * The structural half is asserted too, because "the absence is the enforcement"
 * is a claim about the schema and can be read off the schema: no health table
 * carries a foreign key into the graph, and no health table's DDL so much as
 * mentions it. A column added later fails here rather than three months later in
 * the projection.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
}

interface UploadResult {
  readonly written: number;
  readonly duplicates: number;
}

function fullReport(): Record<HealthType, AuthorisationState> {
  const report: Partial<Record<HealthType, AuthorisationState>> = {};
  for (const type of HEALTH_TYPES) report[type] = "authorised";
  // Safe assertion: the loop above visits every member of HEALTH_TYPES.
  return report as Record<HealthType, AuthorisationState>;
}

/** One day of raw heart rate, at the rate a watch really produces it. */
const A_DAY_OF_HEART_RATE = 1_440;
/** Plus a night of sleep blocks, a day of step totals, and the morning weight. */
const EVERYTHING_ELSE = 560;
const HOW_MANY = A_DAY_OF_HEART_RATE + EVERYTHING_ELSE;

/**
 * A day's worth of measurements, spelled the way HealthKit spells them.
 *
 * Generated rather than fixtured, because the point of the number is the number:
 * a fixture small enough to write out by hand is a fixture too small to show the
 * failure. Every sample has a distinct identity, so all of them are written.
 */
function aDayOfMeasurements(): readonly HealthSampleInput[] {
  const midnight = Date.UTC(2026, 7, 11, 0, 0, 0, 0);
  const samples: HealthSampleInput[] = [];

  for (let minute = 0; minute < A_DAY_OF_HEART_RATE; minute += 1) {
    const at = new Date(midnight + minute * 60_000).toISOString();
    samples.push({
      type: "heartRate",
      startedAt: at,
      endedAt: at,
      value: 58 + (minute % 37),
      source: "Apple Watch",
    });
  }
  for (let quarter = 0; quarter < EVERYTHING_ELSE; quarter += 1) {
    const startedAt = new Date(midnight + quarter * 150_000).toISOString();
    const endedAt = new Date(midnight + quarter * 150_000 + 150_000).toISOString();
    samples.push({
      type: "steps",
      startedAt,
      endedAt,
      value: quarter * 3,
      source: "iPhone",
    });
  }

  return samples;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let token: string;

beforeEach(async () => {
  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig(), deps));
  token = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
});

afterEach(async () => {
  await running.close();
  db.close();
});

/** The people `syl-ulf` evicted, put into the graph the way anything else is. */
function seedTheFamily(): readonly string[] {
  const graph = deps.memory.graph;
  const him = graph.addNode({ kind: "person", label: "The Commander" });
  const wife = graph.addNode({ kind: "person", label: "Amanda" });
  const son = graph.addNode({ kind: "person", label: "Silas" });
  const daughter = graph.addNode({ kind: "person", label: "Evelyn" });
  const weight = graph.addNode({ kind: "goal", label: "Get back to 185 pounds" });

  // Edges, because salience ranks over incident edge weight: five unconnected
  // nodes would be a graph with nothing to lose, which is not the graph this
  // test is about. The far crossing instant keeps the nightly sweep out of it —
  // nothing here is about decay.
  const link = (target: string, reasoning: string): void => {
    graph.infer({
      sourceNode: him.id,
      targetNode: target,
      relation: "about",
      reasoning,
      confidence: 0.9,
      demoteAfter: "2027-01-01T00:00:00.000Z",
    });
  };
  link(wife.id, "He refers to Amanda as his wife.");
  link(son.id, "He refers to Silas as his son.");
  link(daughter.id, "He refers to Evelyn as his daughter.");
  link(weight.id, "The goal is his.");

  return [him.id, wife.id, son.id, daughter.id, weight.id];
}

/** Every table SQLite actually ended up with whose name starts with `memory_`. */
function memoryTables(): readonly string[] {
  const rows = db.handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory\\_%' ESCAPE '\\'")
    .all();
  return rows.map((row) => (row as unknown as { name: string }).name);
}

function countOf(table: string): number {
  // Interpolated, and safe: `table` comes from `sqlite_master` on this same
  // connection, never from anything a caller supplied.
  const row = db.handle.prepare(`SELECT count(*) AS n FROM "${table}"`).get();
  return Number((row as unknown as { n: number }).n);
}

async function uploadADay(): Promise<Envelope<UploadResult>> {
  const response = await fetch(`${running.baseUrl}/api/v1/health/samples`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "Idempotency-Key": "a-real-day",
    },
    body: JSON.stringify({ authorisation: fullReport(), samples: aDayOfMeasurements() }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Envelope<UploadResult>;
}

describe("a health sample cannot become a memory node", () => {
  it("should leave the graph exactly the size it was after two thousand measurements arrive", async () => {
    seedTheFamily();
    const before = new Map(memoryTables().map((table) => [table, countOf(table)]));
    // The check that keeps this test from being vacuous: there has to be a graph
    // here for the samples to fail to get into.
    expect(before.get("memory_nodes")).toBe(5);

    const result = await uploadADay();
    expect(result.data?.written).toBe(HOW_MANY);
    expect(deps.health.count()).toBe(HOW_MANY);

    const after = new Map(memoryTables().map((table) => [table, countOf(table)]));
    // Every memory table, not only `memory_nodes`. A leak into the edge table,
    // the retrieval index or the supersession ledger is the same leak.
    expect(after).toEqual(before);
  });

  it("should leave the document she reads every turn byte-for-byte unchanged", async () => {
    seedTheFamily();
    const before = deps.memory.working.regenerate();
    const preambleBefore = deps.memory.working.preamble();
    expect(preambleBefore).not.toBe("");

    await uploadADay();

    // Regenerated AFTER the upload, from the live graph, exactly as the nightly
    // consolidation lane does it. This is the assertion `syl-ulf` needed and did
    // not have: not "the projection still builds", but "the projection is the
    // same document".
    const after = deps.memory.working.regenerate();
    expect(after.row.digest).toBe(before.row.digest);
    expect(after.row.included).toBe(before.row.included);
    expect(after.row.dropped).toBe(0);
    expect(deps.memory.working.preamble()).toBe(preambleBefore);
  });

  it("should still name his family in the projection, which is the failure syl-ulf actually was", async () => {
    seedTheFamily();
    await uploadADay();
    deps.memory.working.regenerate();

    const preamble = deps.memory.working.preamble();
    for (const who of ["The Commander", "Amanda", "Silas", "Evelyn"]) {
      expect(preamble).toContain(who);
    }
    // And nothing about his heart is in the text that gets prepended to every
    // turn. Raw measurements never ride in working memory — only conclusions do,
    // and a conclusion is written by the review lane, not by an upload.
    expect(preamble).not.toContain("heartRate");
    expect(preamble).not.toContain("Apple Watch");
  });

  it("should hold no node or edge carrying a sample's identity", async () => {
    seedTheFamily();
    await uploadADay();

    // A leak would not have to grow the row count to be a leak — a node relabelled
    // with a measurement is the same failure. So this asks the text.
    for (const table of memoryTables()) {
      const columns = db.handle.prepare(`PRAGMA table_info("${table}")`).all();
      const textColumns = columns
        .map((column) => (column as unknown as { name: string; type: string }))
        .filter((column) => column.type.toUpperCase() === "TEXT")
        .map((column) => column.name);
      if (textColumns.length === 0) continue;

      const rows = db.handle
        .prepare(`SELECT ${textColumns.map((name) => `"${name}"`).join(", ")} FROM "${table}"`)
        .all();

      for (const row of rows) {
        const text = JSON.stringify(row);
        expect(text).not.toContain("heartRate");
        expect(text).not.toContain("Apple Watch");
        expect(text).not.toContain("health_samples");
      }
    }
  });

  it("should carry no column into the graph at all, because the absence IS the enforcement", async () => {
    // The structural half. A rule somebody has to remember is a rule that gets
    // missed on the pull request that looks unrelated, so the schema is asked
    // rather than the reviewer.
    const healthTables = ["health_samples", "health_watermarks", "health_authorisation"];

    for (const table of healthTables) {
      const foreignKeys = db.handle.prepare(`PRAGMA foreign_key_list("${table}")`).all();
      expect(foreignKeys).toEqual([]);

      const row = db.handle
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      const sql = (row as unknown as { sql: string }).sql;
      // Not merely "no foreign key" — no mention. A nullable `memory_node_id`
      // with no constraint on it would pass the check above and be exactly the
      // door this is guarding.
      expect(sql).not.toContain("memory_");
    }

    // And the enforcement is mutual: nothing in the graph's own schema knows
    // these tables exist either.
    for (const table of memoryTables()) {
      const row = db.handle
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      expect((row as unknown as { sql: string }).sql).not.toContain("health_");
    }
  });
});
