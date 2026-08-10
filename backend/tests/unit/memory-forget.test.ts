import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Forgetting, ForgetError, REDACTION_PREFIX } from "../../src/memory/forget.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { SupersessionLedger } from "../../src/memory/supersede.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * Explicit deletion — the Commander's named exception to constraint 6.
 * `syl-eg3`, `syl-010.3.1`, `syl-010.3.2`.
 *
 * Against the REAL shipped migrations, never a hand-built schema. The whole
 * subject of these tests is what the triggers in `0012`, `0015` and `0020` do
 * and do not permit, so a test that built its own tables would be testing a
 * copy of the design instead of the design.
 */

let db: Database;
let graph: MemoryGraph;
let ledger: SupersessionLedger;
let forgetting: Forgetting;
let clockMs = Date.parse("2026-08-10T09:00:00.000Z");
const clock = (): number => clockMs;

const ORDER = { instructedBy: "commander", instructionRef: "syl:message:m1" } as const;

beforeEach(() => {
  clockMs = Date.parse("2026-08-10T09:00:00.000Z");
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  graph = new MemoryGraph({ db, clock });
  ledger = new SupersessionLedger({ db, graph, clock });
  forgetting = new Forgetting({ db, graph, clock });
});

afterEach(() => {
  db.close();
});

const LATER = "2026-09-01T09:00:00.000Z";

/** Confirm a plan the way a caller who has been shown it would. */
function confirmed(plan: { readonly confirmation: string }): {
  readonly instructedBy: "commander";
  readonly instructionRef: string;
  readonly confirmation: string;
} {
  return { ...ORDER, confirmation: plan.confirmation };
}

/**
 * The scene these tests keep deleting out of.
 *
 * A source asserted an observation about a sensitive fact; a night inferred a
 * connection over it and wrote down WHY, quoting the fact's own label; the
 * ledger holds a two-row history of a belief whose value node is the fact.
 * Every residue this bead is about is present exactly once.
 */
function scene(): {
  readonly secret: string;
  readonly other: string;
  readonly source: string;
  readonly inferredEdge: string;
  readonly observedEdge: string;
} {
  const secret = graph.addNode({ kind: "fact", label: "the Boskone acquisition", body: "term sheet signed" }).id;
  const other = graph.addNode({ kind: "person", label: "Sadie" }).id;
  const source = graph.addNode({ kind: "source", label: "a private note" }).id;

  const observedEdge = graph.observe({
    sourceNode: source,
    targetNode: secret,
    relation: "mentions",
    assertedBy: source,
  }).id;
  const inferredEdge = graph.infer({
    sourceNode: secret,
    targetNode: other,
    relation: "involves",
    reasoning: "Sadie chairs the board, so the Boskone acquisition runs through her.",
    confidence: 0.8,
    demoteAfter: LATER,
  }).id;

  ledger.assert({ subject: secret, relation: "status", value: "under diligence" });
  clockMs += 1000;
  ledger.assert({ subject: secret, relation: "status", value: "signed" });

  return { secret, other, source, inferredEdge, observedEdge };
}

function count(sql: string, ...bindings: readonly (string | number)[]): number {
  return (db.prepare(sql).get(...bindings) as { n: number }).n;
}

describe("Forgetting.plan", () => {
  it("should name the node, its edges, and the whole ledger chain without writing anything", () => {
    const { secret, inferredEdge, observedEdge } = scene();

    const plan = forgetting.plan({ nodes: [secret] });

    expect(plan.nodes).toEqual([secret]);
    expect([...plan.edges].sort()).toEqual([inferredEdge, observedEdge].sort());
    expect(plan.assertions).toHaveLength(2);
    expect(plan.assertionKeys).toEqual([{ subject: secret, relation: "status", rows: 2 }]);

    // A plan is a read. Nothing has moved.
    expect(count("SELECT count(*) AS n FROM memory_edges")).toBe(2);
    expect(count("SELECT count(*) AS n FROM memory_assertions")).toBe(2);
    expect(count("SELECT count(*) AS n FROM memory_deletions")).toBe(0);
  });

  it("should refuse a node that is not in the graph", () => {
    expect(() => forgetting.plan({ nodes: ["syl:memory_node:00000000-0000-7000-8000-000000000009"] }))
      .toThrow(ForgetError);
  });

  it("should refuse an empty target, because a delete that names nothing is a bug", () => {
    expect(() => forgetting.plan({ nodes: [] })).toThrow(/at least one node/u);
  });

  it("should name orphaned survivors rather than deleting them", () => {
    const { secret, other } = scene();
    const plan = forgetting.plan({ nodes: [secret] });

    // `other` loses its only edge. It is REPORTED, never deleted: the cascade
    // stops at one hop.
    expect(plan.orphaned).toContain(other);
    expect(plan.nodes).not.toContain(other);
  });

  it("should find the reasoning of a SURVIVING inference that quotes the deleted node", () => {
    const { secret, other } = scene();
    const third = graph.addNode({ kind: "event", label: "the Q3 board meeting" }).id;
    // Touches neither endpoint of the deleted node — but quotes its label.
    const bystander = graph.infer({
      sourceNode: other,
      targetNode: third,
      relation: "attends",
      reasoning: "Sadie is there because the Boskone acquisition is on the agenda.",
      confidence: 0.6,
      demoteAfter: LATER,
    }).id;

    const plan = forgetting.plan({ nodes: [secret] });

    expect(plan.edges).not.toContain(bystander);
    expect(plan.redactedEdges).toContain(bystander);
  });

  it("should report a surviving node's own words as residue without touching them", () => {
    const { secret } = scene();
    const memo = graph.addNode({
      kind: "memory",
      label: "call with counsel",
      body: "we talked about the Boskone acquisition for an hour",
    }).id;

    const plan = forgetting.plan({ nodes: [secret] });

    expect(plan.residue).toContainEqual({ nodeId: memo, field: "body" });
    expect(plan.nodes).not.toContain(memo);
    expect(plan.redactedEdges).not.toContain(memo);
  });

  it("should not match on a label too short to be a quotation", () => {
    const tiny = graph.addNode({ kind: "fact", label: "ab" }).id;
    const a = graph.addNode({ kind: "person", label: "someone" }).id;
    const b = graph.addNode({ kind: "person", label: "another" }).id;
    graph.infer({
      sourceNode: a,
      targetNode: b,
      relation: "knows",
      reasoning: "they both grabbed a cab last week",
      confidence: 0.5,
      demoteAfter: LATER,
    });

    // "ab" occurs inside "grabbed" and "cab". A two-character label is not a
    // quotation and must not redact half the graph.
    expect(forgetting.plan({ nodes: [tiny] }).redactedEdges).toEqual([]);
  });

  it("should carry a confirmation that changes when the graph moves under it", () => {
    const { secret, other } = scene();
    const first = forgetting.plan({ nodes: [secret] }).confirmation;

    const third = graph.addNode({ kind: "event", label: "a board meeting" }).id;
    graph.infer({
      sourceNode: secret,
      targetNode: third,
      relation: "discussed_at",
      reasoning: "it was on the agenda",
      confidence: 0.5,
      demoteAfter: LATER,
    });

    expect(forgetting.plan({ nodes: [secret] }).confirmation).not.toBe(first);
    expect(other).toBeTruthy();
  });
});

describe("Forgetting.execute", () => {
  it("should remove the node, both species of edge, and every ledger row of the key", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });

    const record = forgetting.execute(plan, confirmed(plan));

    expect(graph.getNode(secret)).toBeNull();
    expect(count("SELECT count(*) AS n FROM memory_edges")).toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_assertions")).toBe(0);
    expect(record.nodes).toBe(1);
    expect(record.edges).toBe(2);
    expect(record.assertions).toBe(2);
  });

  it("should reach the reasoning text: no row anywhere still quotes the forgotten thing", () => {
    const { secret, other } = scene();
    const third = graph.addNode({ kind: "event", label: "the Q3 board meeting" }).id;
    graph.infer({
      sourceNode: other,
      targetNode: third,
      relation: "attends",
      reasoning: "Sadie is there because the Boskone acquisition is on the agenda.",
      confidence: 0.6,
      demoteAfter: LATER,
    });

    const plan = forgetting.plan({ nodes: [secret] });
    forgetting.execute(plan, confirmed(plan));

    const quoting = count(
      "SELECT count(*) AS n FROM memory_edges WHERE reasoning LIKE '%Boskone%'",
    );
    expect(quoting).toBe(0);
    const redacted = db
      .prepare("SELECT reasoning FROM memory_edges WHERE kind = 'inferred'")
      .all() as unknown as readonly { reasoning: string }[];
    expect(redacted).toHaveLength(1);
    expect(redacted[0]?.reasoning.startsWith(REDACTION_PREFIX)).toBe(true);
  });

  it("should leave the closed ledger rows unable to answer 'what did I believe in March'", () => {
    const { secret } = scene();
    // Both rows exist first: the open one and the one it closed.
    expect(ledger.history(secret, "status")).toHaveLength(2);

    const plan = forgetting.plan({ nodes: [secret] });
    forgetting.execute(plan, confirmed(plan));

    expect(ledger.history(secret, "status")).toEqual([]);
    expect(ledger.believedAt(secret, "status", "2026-08-10T09:00:00.500Z")).toBeNull();
  });

  it("should redact the dream log's prose while leaving the session logged", () => {
    const { secret, other, inferredEdge } = scene();
    db.prepare(
      `INSERT INTO dream_sessions (id, night, tz, started_at, ended_at, outcome, token_ceiling)
       VALUES ('syl:dream_session:00000000-0000-7000-8000-0000000000a1', '2026-08-09',
               'America/Chicago', '2026-08-09T03:00:00.000Z', '2026-08-09T03:20:00.000Z',
               'completed', 100000)`,
    ).run();
    db.prepare(
      `INSERT INTO dream_edge_reasoning
         (session_id, disposition, edge_id, source_node, target_node, reasoning, created_at)
       VALUES ('syl:dream_session:00000000-0000-7000-8000-0000000000a1', 'created', ?, ?, ?, ?, ?)`,
    ).run(
      inferredEdge,
      secret,
      other,
      "Sadie chairs the board, so the Boskone acquisition runs through her.",
      "2026-08-09T03:00:00.000Z",
    );

    const plan = forgetting.plan({ nodes: [secret] });
    forgetting.execute(plan, confirmed(plan));

    // Constraint 7: the session is still logged. Constraint 6's exception: the
    // prose it quoted is gone.
    expect(count("SELECT count(*) AS n FROM dream_sessions")).toBe(1);
    expect(count("SELECT count(*) AS n FROM dream_edge_reasoning")).toBe(1);
    expect(count("SELECT count(*) AS n FROM dream_edge_reasoning WHERE reasoning LIKE '%Boskone%'"))
      .toBe(0);
  });

  it("should discard the working-memory projection, which is prepended to every turn", () => {
    const { secret } = scene();
    db.prepare(
      `INSERT INTO working_memory (id, text, digest, bytes, lines, included, dropped, generated_at)
       VALUES (1, 'the Boskone acquisition is signed', 'd', 33, 1, 1, 0, '2026-08-10T08:00:00.000Z')`,
    ).run();

    const plan = forgetting.plan({ nodes: [secret] });
    forgetting.execute(plan, confirmed(plan));

    expect(count("SELECT count(*) AS n FROM working_memory")).toBe(0);
  });

  it("should remove the trust feedback, whose note is his own words about the memory", () => {
    const { secret } = scene();
    db.prepare(
      `INSERT INTO memory_feedback (node_id, verdict, trust_before, trust_after, note, created_at)
       VALUES (?, 'unhelpful', 0.8, 0.6, 'never bring up the Boskone acquisition again', ?)`,
    ).run(secret, "2026-08-10T08:00:00.000Z");

    const plan = forgetting.plan({ nodes: [secret] });
    expect(plan.feedback).toBe(1);
    forgetting.execute(plan, confirmed(plan));

    expect(count("SELECT count(*) AS n FROM memory_feedback")).toBe(0);
  });

  it("should clear the keyword index, so the label is not still searchable", () => {
    const { secret } = scene();
    expect(count("SELECT count(*) AS n FROM memory_nodes_fts WHERE node_id = ?", secret)).toBe(1);

    const plan = forgetting.plan({ nodes: [secret] });
    forgetting.execute(plan, confirmed(plan));

    expect(count("SELECT count(*) AS n FROM memory_nodes_fts WHERE node_id = ?", secret)).toBe(0);
  });

  it("should refuse a confirmation that no longer describes the graph", () => {
    const { secret, other } = scene();
    const plan = forgetting.plan({ nodes: [secret] });

    // Something else happens between the confirmation and the delete.
    graph.infer({
      sourceNode: secret,
      targetNode: other,
      relation: "also_involves",
      reasoning: "a second connection, drawn after he was shown the plan",
      confidence: 0.4,
      demoteAfter: LATER,
    });

    expect(() => forgetting.execute(plan, confirmed(plan))).toThrow(/stale/u);
    expect(graph.getNode(secret)).not.toBeNull();
  });

  it("should refuse an unconfirmed order outright", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });

    expect(() =>
      forgetting.execute(plan, { ...ORDER, confirmation: "0".repeat(64) }),
    ).toThrow(/confirm/u);
    expect(graph.getNode(secret)).not.toBeNull();
    expect(count("SELECT count(*) AS n FROM memory_deletions")).toBe(0);
  });

  it("should leave nothing behind when a step fails: the whole delete is one transaction", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });

    db.exec(
      `CREATE TRIGGER injected_fault BEFORE DELETE ON memory_nodes
       BEGIN SELECT RAISE(ABORT, 'injected fault'); END`,
    );

    expect(() => forgetting.execute(plan, confirmed(plan))).toThrow(/injected fault/u);

    db.exec("DROP TRIGGER injected_fault");
    expect(graph.getNode(secret)).not.toBeNull();
    expect(count("SELECT count(*) AS n FROM memory_assertions")).toBe(2);
    expect(count("SELECT count(*) AS n FROM memory_deletions")).toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_edges WHERE reasoning LIKE '%Boskone%'")).toBe(1);
  });
});

describe("the audit record", () => {
  it("should record the shape, the authority and the instant — and no content", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });

    const record = forgetting.execute(plan, confirmed(plan));

    expect(record.instructedBy).toBe("commander");
    expect(record.instructionRef).toBe("syl:message:m1");
    expect(record.executedAt).toBe("2026-08-10T09:00:01.000Z");
    expect(record.nodes).toBe(1);

    // Nothing in the audit row is the deleted material. Proven by scanning
    // every column of it for the label that was deleted.
    const row = db.prepare("SELECT * FROM memory_deletions WHERE id = ?").get(record.id);
    expect(JSON.stringify(row)).not.toMatch(/Boskone/u);
    // …and by the digest being able to CONFIRM the material without holding it.
    expect(record.digest).toHaveLength(64);
    expect(record.digest).toBe(plan.digest);
  });

  it("should be readable back, so a deletion is never indistinguishable from data loss", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });
    const record = forgetting.execute(plan, confirmed(plan));

    expect(forgetting.record(record.id)).toEqual(record);
    expect(forgetting.records()).toEqual([record]);
    // The scope names every id removed, so "which edge went?" is answerable.
    expect(forgetting.scopeOf(record.id).map((entry) => entry.target).sort()).toEqual(
      [...plan.edges, ...plan.assertions, ...plan.nodes].sort(),
    );
  });

  it("should itself be un-erasable: an audit that can be deleted is not an audit", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });
    const record = forgetting.execute(plan, confirmed(plan));

    expect(() => db.prepare("DELETE FROM memory_deletions WHERE id = ?").run(record.id)).toThrow(
      /never deleted/u,
    );
    expect(() =>
      db.prepare("UPDATE memory_deletions SET instructed_by = 'system' WHERE id = ?").run(record.id),
    ).toThrow(/never rewritten/u);
    expect(() => db.prepare("DELETE FROM memory_deletion_scope").run()).toThrow(/never deleted/u);
  });

  it("should leave no authority window open after it commits", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });
    forgetting.execute(plan, confirmed(plan));

    expect(forgetting.pending()).toEqual([]);
    expect(count("SELECT count(*) AS n FROM memory_deletions WHERE executed_at IS NULL")).toBe(0);
  });
});

describe("constraint 6 still binds the system", () => {
  it("should still refuse a bare DELETE of an inferred edge", () => {
    const { inferredEdge } = scene();

    expect(() => db.prepare("DELETE FROM memory_edges WHERE id = ?").run(inferredEdge)).toThrow(
      /never deleted/u,
    );
    expect(graph.getEdge(inferredEdge)).not.toBeNull();
  });

  it("should still refuse a bare DELETE of an assertion", () => {
    const { secret } = scene();
    const open = ledger.current(secret, "status");
    expect(open).not.toBeNull();

    expect(() =>
      db.prepare("DELETE FROM memory_assertions WHERE id = ?").run(open?.id ?? ""),
    ).toThrow(/never deleted/u);
  });

  it("should refuse a delete authorised for a DIFFERENT row", () => {
    const { secret, inferredEdge } = scene();
    const other = graph.addNode({ kind: "fact", label: "an unrelated fact" }).id;
    const spare = graph.infer({
      sourceNode: other,
      targetNode: secret,
      relation: "unrelated_to",
      reasoning: "nothing to do with it",
      confidence: 0.3,
      demoteAfter: LATER,
    }).id;

    // An authority window open for `spare` does not reach `inferredEdge`. The
    // exception is per-row, which is what makes it narrow rather than a mode.
    db.prepare(
      `INSERT INTO memory_deletions
         (id, instructed_by, instruction_ref, confirmation, digest,
          nodes, edges, assertions, redactions, requested_at)
       VALUES ('syl:memory_deletion:00000000-0000-7000-8000-0000000000b1', 'commander', NULL,
               ?, ?, 0, 1, 0, 0, '2026-08-10T09:00:00.000Z')`,
    ).run("a".repeat(64), "b".repeat(64));
    db.prepare(
      `INSERT INTO memory_deletion_scope (deletion_id, target, kind)
       VALUES ('syl:memory_deletion:00000000-0000-7000-8000-0000000000b1', ?, 'edge')`,
    ).run(spare);

    expect(() => db.prepare("DELETE FROM memory_edges WHERE id = ?").run(inferredEdge)).toThrow(
      /never deleted/u,
    );
    db.prepare("DELETE FROM memory_edges WHERE id = ?").run(spare);
    expect(graph.getEdge(spare)).toBeNull();
  });

  it("should close the authority window once the deletion is stamped executed", () => {
    const { secret } = scene();
    const plan = forgetting.plan({ nodes: [secret] });
    const record = forgetting.execute(plan, confirmed(plan));

    // Replaying the same scope against a new edge gets nowhere: the window is
    // shut, so a leftover audit row is not a standing permission.
    const a = graph.addNode({ kind: "fact", label: "a new fact" }).id;
    const b = graph.addNode({ kind: "fact", label: "another new fact" }).id;
    const fresh = graph.infer({
      sourceNode: a,
      targetNode: b,
      relation: "relates_to",
      reasoning: "drawn after the deletion",
      confidence: 0.5,
      demoteAfter: LATER,
    }).id;
    db.prepare(
      "INSERT INTO memory_deletion_scope (deletion_id, target, kind) VALUES (?, ?, 'edge')",
    ).run(record.id, fresh);

    expect(() => db.prepare("DELETE FROM memory_edges WHERE id = ?").run(fresh)).toThrow(
      /never deleted/u,
    );
  });
});

describe("vectors", () => {
  it("should report nothing to reach when the vector table was never created", () => {
    const { secret } = scene();
    expect(forgetting.plan({ nodes: [secret] }).vectors).toBe(0);
  });

  it("should delete the embedding, which is a lossy copy of the text", () => {
    const { secret } = scene();
    // A stand-in with `vec0`'s `node_id` column. The real table needs the
    // loadable extension; the statement under test is the same either way.
    db.exec("CREATE TABLE memory_vectors (node_id TEXT PRIMARY KEY, embedding BLOB)");
    db.prepare("INSERT INTO memory_vectors (node_id, embedding) VALUES (?, x'00')").run(secret);

    const plan = forgetting.plan({ nodes: [secret] });
    expect(plan.vectors).toBe(1);
    forgetting.execute(plan, confirmed(plan));

    expect(count("SELECT count(*) AS n FROM memory_vectors")).toBe(0);
  });

  it("should refuse rather than half-forget when the vector table exists but cannot be read", () => {
    const { secret } = scene();
    db.exec("CREATE VIEW memory_vectors AS SELECT node_id FROM a_table_that_is_not_there");

    expect(() => forgetting.plan({ nodes: [secret] })).toThrow(/vector/u);
  });
});
