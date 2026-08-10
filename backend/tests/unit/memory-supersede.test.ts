import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryGraph } from "../../src/memory/graph.js";
import { isMemoryAssertionId, newMemoryAssertionId } from "../../src/memory/schema.js";
import {
  LedgerError,
  SupersessionLedger,
  type Assertion,
} from "../../src/memory/supersede.js";
import { idType, isId } from "../../src/services/id.js";
import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The supersession ledger — `syl-005.3.3` — against the REAL shipped migration.
 *
 * The point of this bead is a SHAPE: a unique partial index that makes "at most
 * one current value per (subject, relation)" an invariant the store enforces. A
 * test that built its own tables would be testing a copy of that shape, and the
 * copy is exactly where the invariant would be missing.
 *
 * What must hold, and what breaks if it does not:
 *
 *  - **Deterministic.** No similarity threshold, no model call at read time.
 *    Embedding similarity cannot tell stale from current — a contradiction is
 *    on average MORE cosine-similar to the original than a genuine duplicate —
 *    so anything approximate here serves last year's answer 15-40% of the time.
 *  - **Nothing is destroyed.** The closed rows ARE the answer to "what did I
 *    believe in March?". A DELETE, or an UPDATE that rewrites what a row
 *    claimed, destroys the only thing this table exists for.
 *  - **Bi-temporal.** Valid time and transaction time come apart, and every
 *    interesting question is about the gap between them.
 */

const MARCH = "2026-03-01T09:00:00.000Z";
const APRIL = "2026-04-01T09:00:00.000Z";
const JUNE = "2026-06-01T09:00:00.000Z";
const AUGUST = "2026-08-09T12:00:00.000Z";

let db: Database;
let graph: MemoryGraph;
let ledger: SupersessionLedger;
let clockMs: number;

/** The subject every test below makes claims about. */
let commander: string;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  clockMs = Date.parse(MARCH);
  const clock = () => clockMs;
  graph = new MemoryGraph({ db, clock });
  ledger = new SupersessionLedger({ db, graph, clock });
  commander = graph.addNode({ kind: "person", label: "the Commander" }).id;
});

afterEach(() => {
  db.close();
});

/** A `fact` node standing for one value of a claim. */
function valueNode(label: string): string {
  return graph.addNode({ kind: "fact", label }).id;
}

/** Assert `value` for the Commander's employer at the current clock. */
function employer(value: string, extra: { valueNode?: string; validFrom?: string } = {}) {
  return ledger.assert({
    subject: commander,
    relation: "works_at",
    value,
    ...(extra.valueNode === undefined ? {} : { valueNode: extra.valueNode }),
    ...(extra.validFrom === undefined ? {} : { validFrom: extra.validFrom }),
  });
}

// ── Ids ────────────────────────────────────────────────────────────────────

describe("assertion ids", () => {
  it("should live in their own namespace, because an assertion is not a node", () => {
    const id = newMemoryAssertionId();
    expect(isId(id)).toBe(true);
    expect(idType(id)).toBe("memory_assertion");
    expect(isMemoryAssertionId(id)).toBe(true);
    expect(id).toHaveLength(57);
  });

  it("should not be mistaken for a memory node id", () => {
    expect(isMemoryAssertionId(commander)).toBe(false);
  });

  it("should be unique", () => {
    expect(newMemoryAssertionId()).not.toBe(newMemoryAssertionId());
  });
});

// ── assert ─────────────────────────────────────────────────────────────────

describe("SupersessionLedger.assert", () => {
  it("should open a row when nothing is known about the key yet", () => {
    const result = employer("Acme");

    expect(result.superseded).toBeNull();
    expect(result.unchanged).toBe(false);
    expect(result.current.value).toBe("Acme");
    expect(result.current.supersededAt).toBeNull();
    expect(result.current.validTo).toBeNull();
    expect(result.current.recordedAt).toBe(MARCH);
    expect(result.current.validFrom).toBe(MARCH);
  });

  it("should close the old row and open the new one when the value changes", () => {
    const first = employer("Acme").current;
    clockMs = Date.parse(JUNE);
    const result = employer("Initrode");

    expect(result.superseded?.id).toBe(first.id);
    expect(result.superseded?.supersededAt).toBe(JUNE);
    expect(result.superseded?.supersededBy).toBe(result.current.id);
    expect(result.superseded?.validTo).toBe(JUNE);
    expect(result.current.value).toBe("Initrode");
    expect(result.current.supersededAt).toBeNull();
  });

  it("should be idempotent on an identical value, and open no second row", () => {
    // Byte equality, not a similarity threshold. Idempotence is not merging:
    // aggressive near-duplicate merging is measured to collapse accuracy from
    // 0.82 to 0.62, so two values that merely LOOK alike stay two rows.
    const first = employer("Acme").current;
    clockMs = Date.parse(JUNE);
    const again = employer("Acme");

    expect(again.unchanged).toBe(true);
    expect(again.superseded).toBeNull();
    expect(again.current.id).toBe(first.id);
    expect(ledger.history(commander, "works_at")).toHaveLength(1);
  });

  it("should treat a merely-similar value as a different value", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    const result = employer("Acme Corp");

    expect(result.unchanged).toBe(false);
    expect(ledger.history(commander, "works_at")).toHaveLength(2);
  });

  it("should keep separate histories for different relations on one subject", () => {
    employer("Acme");
    ledger.assert({ subject: commander, relation: "lives_in", value: "Austin" });
    clockMs = Date.parse(JUNE);
    employer("Initrode");

    expect(ledger.current(commander, "lives_in")?.value).toBe("Austin");
    expect(ledger.current(commander, "works_at")?.value).toBe("Initrode");
  });

  it("should record a claim that became true before it was learned", () => {
    // The whole reason for two clocks. He changed jobs in March and mentioned
    // it in June; for three months Syl believed something already false.
    employer("Acme");
    clockMs = Date.parse(JUNE);
    const result = employer("Initrode", { validFrom: APRIL });

    expect(result.current.validFrom).toBe(APRIL);
    expect(result.current.recordedAt).toBe(JUNE);
    expect(result.superseded?.validTo).toBe(APRIL);
    expect(result.superseded?.supersededAt).toBe(JUNE);
  });

  it("should demote the node carrying the stale value, and leave it addressable", () => {
    // `0012_memory_core.sql` says supersession is what moves a node to cold.
    const acme = valueNode("Acme");
    employer("Acme", { valueNode: acme });
    clockMs = Date.parse(JUNE);
    employer("Initrode", { valueNode: valueNode("Initrode") });

    expect(graph.getNode(acme)?.tier).toBe("cold");
    expect(graph.listNodes({ kind: "fact" }).map((node) => node.label)).toEqual(["Initrode"]);
  });

  it("should refuse a subject that is not a type-prefixed id", () => {
    expect(() => ledger.assert({ subject: "commander", relation: "works_at", value: "Acme" })).toThrow(
      LedgerError,
    );
  });

  it("should refuse a blank relation or a blank value", () => {
    expect(() => ledger.assert({ subject: commander, relation: " \n ", value: "Acme" })).toThrow(
      LedgerError,
    );
    expect(() => ledger.assert({ subject: commander, relation: "works_at", value: "\t" })).toThrow(
      LedgerError,
    );
  });

  it("should refuse a value node that is not in the graph", () => {
    expect(() =>
      employer("Acme", { valueNode: "syl:memory_node:00000000-0000-7000-8000-000000000001" }),
    ).toThrow(LedgerError);
  });

  it("should refuse a validity start that is not an RFC 3339 UTC instant", () => {
    expect(() => employer("Acme", { validFrom: "2026-03-01T09:00:00+02:00" })).toThrow(LedgerError);
  });

  it("should refuse before closing anything when the value node is unknown", () => {
    const first = employer("Acme").current;
    clockMs = Date.parse(JUNE);
    expect(() =>
      employer("Initrode", { valueNode: "syl:memory_node:00000000-0000-7000-8000-000000000002" }),
    ).toThrow(LedgerError);

    const still = ledger.current(commander, "works_at");
    expect(still?.id).toBe(first.id);
    expect(still?.supersededAt).toBeNull();
  });

  it("should roll the close back when opening the new row fails", () => {
    // Atomicity is not a nicety here. Closing the old row and failing to open
    // the new one leaves the key with NO current value — a fact silently
    // forgotten, which is the failure constraints 4 and 6 both exist to
    // prevent. Injected as a real fault against the real schema, because a
    // half-applied supersession is invisible from every other layer.
    const first = employer("Acme").current;
    db.exec(
      `CREATE TRIGGER test_refuse_insert BEFORE INSERT ON memory_assertions
       BEGIN SELECT RAISE(ABORT, 'injected fault'); END`,
    );
    clockMs = Date.parse(JUNE);

    try {
      expect(() => employer("Initrode")).toThrow(/injected fault/u);
    } finally {
      db.exec("DROP TRIGGER test_refuse_insert");
    }

    const still = ledger.current(commander, "works_at");
    expect(still?.id).toBe(first.id);
    expect(still?.supersededAt).toBeNull();
    expect(still?.validTo).toBeNull();
    expect(ledger.history(commander, "works_at")).toHaveLength(1);
  });
});

// ── retire ─────────────────────────────────────────────────────────────────

describe("SupersessionLedger.retire", () => {
  it("should close a claim with no successor", () => {
    // "He stopped working there and nothing took its place" is a real thing to
    // learn, and forcing it to invent a successor would be a fabrication.
    employer("Acme");
    clockMs = Date.parse(JUNE);
    const retired = ledger.retire(commander, "works_at");

    expect(retired.supersededAt).toBe(JUNE);
    expect(retired.supersededBy).toBeNull();
    expect(ledger.current(commander, "works_at")).toBeNull();
  });

  it("should still answer what was believed before the retirement", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    ledger.retire(commander, "works_at");

    expect(ledger.believedAt(commander, "works_at", APRIL)?.value).toBe("Acme");
    expect(ledger.believedAt(commander, "works_at", AUGUST)).toBeNull();
  });

  it("should refuse to retire a key with no current value", () => {
    expect(() => ledger.retire(commander, "works_at")).toThrow(LedgerError);
  });

  it("should let a later assertion re-open the key without touching the closed rows", () => {
    const first = employer("Acme").current;
    clockMs = Date.parse(JUNE);
    ledger.retire(commander, "works_at");
    clockMs = Date.parse(AUGUST);
    employer("Initrode");

    expect(ledger.current(commander, "works_at")?.value).toBe("Initrode");
    expect(ledger.history(commander, "works_at")).toHaveLength(2);
    expect(ledger.getAssertion(first.id)?.supersededBy).toBeNull();
  });
});

// ── current ────────────────────────────────────────────────────────────────

describe("SupersessionLedger.current", () => {
  it("should return the open row for a key", () => {
    employer("Acme");
    expect(ledger.current(commander, "works_at")?.value).toBe("Acme");
  });

  it("should return null for a key nothing has been asserted about", () => {
    expect(ledger.current(commander, "drives")).toBeNull();
  });

  it("should never return a superseded value, however much history there is", () => {
    // The failure this whole bead exists to prevent: ordinary retrieval serves
    // a superseded value 15-40% of the time; the ledger serves one never.
    const values = ["Acme", "Initrode", "Globex", "Umbrella", "Stark"];
    for (const [index, value] of values.entries()) {
      clockMs = Date.parse(MARCH) + index * 86_400_000;
      employer(value);
    }
    expect(ledger.current(commander, "works_at")?.value).toBe("Stark");
    expect(ledger.history(commander, "works_at")).toHaveLength(values.length);
  });

  it("should refuse a subject that is not a type-prefixed id", () => {
    expect(() => ledger.current("nope", "works_at")).toThrow(LedgerError);
  });
});

// ── believedAt — "what did I believe in March?" ────────────────────────────

describe("SupersessionLedger.believedAt", () => {
  it("should answer with what Syl believed at that instant, not with what is true now", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    employer("Initrode", { validFrom: APRIL });

    expect(ledger.believedAt(commander, "works_at", APRIL)?.value).toBe("Acme");
    expect(ledger.believedAt(commander, "works_at", AUGUST)?.value).toBe("Initrode");
  });

  it("should return null for an instant before anything was known", () => {
    clockMs = Date.parse(JUNE);
    employer("Acme");
    expect(ledger.believedAt(commander, "works_at", MARCH)).toBeNull();
  });

  it("should return exactly one row at every instant across a long history", () => {
    // The unique partial index is what guarantees the belief intervals never
    // overlap. If two rows were ever open at once, this is where it shows.
    for (const [index, value] of ["Acme", "Initrode", "Globex"].entries()) {
      clockMs = Date.parse(MARCH) + index * 30 * 86_400_000;
      employer(value);
    }
    for (let day = 0; day < 90; day += 1) {
      const at = new Date(Date.parse(MARCH) + day * 86_400_000).toISOString();
      expect(ledger.believedAt(commander, "works_at", at)).not.toBeNull();
    }
  });

  it("should refuse an instant that is not an RFC 3339 UTC instant", () => {
    employer("Acme");
    expect(() => ledger.believedAt(commander, "works_at", "March")).toThrow(LedgerError);
  });
});

// ── trueAt — the other clock ───────────────────────────────────────────────

describe("SupersessionLedger.trueAt", () => {
  it("should answer with what Syl NOW thinks was the case then", () => {
    // The bi-temporal difference, stated as an assertion. In April, Syl
    // BELIEVED "Acme". She now knows "Initrode" was already TRUE in April.
    employer("Acme");
    clockMs = Date.parse(JUNE);
    employer("Initrode", { validFrom: APRIL });

    expect(ledger.believedAt(commander, "works_at", APRIL)?.value).toBe("Acme");
    expect(ledger.trueAt(commander, "works_at", APRIL)?.value).toBe("Initrode");
  });

  it("should return the earlier value for an instant inside its validity interval", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    employer("Initrode");

    expect(ledger.trueAt(commander, "works_at", APRIL)?.value).toBe("Acme");
    expect(ledger.trueAt(commander, "works_at", AUGUST)?.value).toBe("Initrode");
  });

  it("should return null before the earliest validity interval starts", () => {
    employer("Acme");
    expect(ledger.trueAt(commander, "works_at", "2026-01-01T00:00:00.000Z")).toBeNull();
  });

  it("should refuse an instant that is not an RFC 3339 UTC instant", () => {
    expect(() => ledger.trueAt(commander, "works_at", "2026-03")).toThrow(LedgerError);
  });
});

// ── history and beliefsAt ──────────────────────────────────────────────────

describe("SupersessionLedger.history", () => {
  it("should return every row for a key, oldest first", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    employer("Initrode");

    expect(ledger.history(commander, "works_at").map((row) => row.value)).toEqual([
      "Acme",
      "Initrode",
    ]);
  });

  it("should return an empty list for a key nothing has been asserted about", () => {
    expect(ledger.history(commander, "drives")).toEqual([]);
  });

  it("should chain each closed row to the one that replaced it", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    employer("Initrode");
    const rows = ledger.history(commander, "works_at") as [Assertion, Assertion];

    expect(rows[0].supersededBy).toBe(rows[1].id);
    expect(rows[1].supersededBy).toBeNull();
  });
});

describe("SupersessionLedger.beliefsAt", () => {
  it("should return everything believed about a subject at an instant", () => {
    employer("Acme");
    ledger.assert({ subject: commander, relation: "lives_in", value: "Austin" });
    clockMs = Date.parse(JUNE);
    employer("Initrode");
    ledger.assert({ subject: commander, relation: "lives_in", value: "Dallas" });

    expect(
      ledger.beliefsAt(commander, APRIL).map((row) => `${row.relation}=${row.value}`),
    ).toEqual(["lives_in=Austin", "works_at=Acme"]);
    expect(
      ledger.beliefsAt(commander, AUGUST).map((row) => `${row.relation}=${row.value}`),
    ).toEqual(["lives_in=Dallas", "works_at=Initrode"]);
  });

  it("should return an empty list before anything was known about the subject", () => {
    employer("Acme");
    expect(ledger.beliefsAt(commander, "2026-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("should refuse an instant that is not an RFC 3339 UTC instant", () => {
    expect(() => ledger.beliefsAt(commander, "whenever")).toThrow(LedgerError);
  });
});

// ── The shape the store enforces ───────────────────────────────────────────

describe("the ledger's structural guarantees", () => {
  it("should refuse a second open row for one key, in the store rather than in TypeScript", () => {
    // The invariant, asserted against the index itself. A check-then-write in
    // TypeScript is a race a retry can slip past, and losing it leaves two
    // current values for one fact.
    const open = ledger.current(commander, "works_at") ?? employer("Acme").current;
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory_assertions
             (id, subject, relation, value, value_node, valid_from, valid_to,
              recorded_at, superseded_at, superseded_by, asserted_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(newMemoryAssertionId(), open.subject, open.relation, "Initrode", JUNE, JUNE, JUNE, JUNE),
    ).toThrow(/UNIQUE/u);
  });

  it("should never let an assertion be deleted", () => {
    const open = employer("Acme").current;
    expect(() => db.prepare("DELETE FROM memory_assertions WHERE id = ?").run(open.id)).toThrow(
      /never deleted/u,
    );
    expect(ledger.getAssertion(open.id)).not.toBeNull();
  });

  it("should never let a row's claim be rewritten after the fact", () => {
    const open = employer("Acme").current;
    expect(() =>
      db.prepare("UPDATE memory_assertions SET value = ? WHERE id = ?").run("Initrode", open.id),
    ).toThrow(/never rewritten/u);
  });

  it("should never let a closed row be re-opened", () => {
    employer("Acme");
    clockMs = Date.parse(JUNE);
    const closed = employer("Initrode").superseded as Assertion;
    expect(() =>
      db
        .prepare("UPDATE memory_assertions SET superseded_at = NULL WHERE id = ?")
        .run(closed.id),
    ).toThrow(/never rewritten/u);
  });

  it("should answer the current value from the partial index whatever the history costs", () => {
    // Bounded growth as a CONSEQUENCE of supersession rather than a goal
    // pursued by compression: the read touches the open rows only.
    for (let index = 0; index < 40; index += 1) {
      clockMs = Date.parse(MARCH) + index * 86_400_000;
      employer(`Employer ${String(index)}`);
    }
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM memory_assertions ` +
          `WHERE subject = ? AND relation = ? AND superseded_at IS NULL`,
      )
      .all(commander, "works_at")
      .map((row) => String((row as { detail: string }).detail))
      .join(" ");

    expect(plan).toContain("memory_assertions_current_idx");
    expect(plan).not.toContain("SCAN memory_assertions");
  });
});
