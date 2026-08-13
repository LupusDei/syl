import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The verdict store's own edges (`syl-024.1`).
 *
 * `0030` gave her somewhere to put what she made of a render. What it could not
 * express is that those verdicts CORRECT EACH OTHER — her account:
 *
 * > "My findings are a chain that corrects itself: the smile is the problem →
 * > no, solidity is → no, the anchor is → confirmed, it was the anchor. Right
 * > now those four are orphans of equal weight, so nothing tells a reader that
 * > the last one killed the first."
 *
 * These edges stay in `render_verdicts` and do not become graph edges. The
 * Commander ruled on 2026-08-11 that a verdict on her own face is not a fact
 * about his life and that the store must remain droppable — and droppability
 * survives *because* the edges are columns here. Dropping the table drops them;
 * a graph edge would outlive the table and dangle. That property is the last
 * test in this file, and it is the one that would fail if anyone moved these
 * into the graph.
 */

let db: Database;

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  applyMigrations(db, readMigrations(MIGRATIONS_DIR));
  counter = 0;
});

afterEach(() => {
  db.close();
});

const NOW = "2026-08-13T12:00:00.000Z";

let counter = 0;

/** Insert a verdict directly, below the service, and return its id. */
function addVerdict(
  overrides: Partial<{
    id: string;
    render: string;
    verdict: string;
    supersedes: string | null;
    anchorFace: string | null;
  }> = {},
): string {
  counter += 1;
  const id = overrides.id ?? `syl:render_verdict:${String(counter).padStart(4, "0")}`;
  db.prepare(
    `INSERT INTO render_verdicts
       (id, render_name, verdict, supersedes, anchor_face, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.render ?? "syl-close-01",
    overrides.verdict ?? "The smile is the problem.",
    overrides.supersedes ?? null,
    overrides.anchorFace ?? null,
    NOW,
  );
  return id;
}

describe("render_verdicts — a verdict remembers what corrected it", () => {
  it("should let a verdict name the one it supersedes", () => {
    const first = addVerdict({ verdict: "The smile is the problem." });
    const second = addVerdict({ verdict: "No — solidity is.", supersedes: first });

    expect(
      db.prepare("SELECT supersedes FROM render_verdicts WHERE id = ?").get(second),
    ).toEqual({ supersedes: first });
  });

  it("should leave both new columns NULL for a verdict that corrects nothing", () => {
    // Every row `0030` wrote predates these columns, and a first finding in a
    // fresh chain corrects nothing either. Neither is an incomplete row.
    const only = addVerdict();

    expect(
      db.prepare("SELECT supersedes, anchor_face FROM render_verdicts WHERE id = ?").get(only),
    ).toEqual({ supersedes: null, anchor_face: null });
  });

  it("should refuse a verdict superseding one that does not exist", () => {
    // The reference is what makes the chain a chain. A dangling one would read
    // as "this corrected something" while naming nothing a reader can follow.
    expect(() => addVerdict({ supersedes: "syl:render_verdict:nope" })).toThrow();
  });

  it("should refuse a verdict that supersedes itself", () => {
    const id = "syl:render_verdict:self";
    expect(() => addVerdict({ id, supersedes: id })).toThrow();
  });

  it("should let the chain cross renders, because the search does", () => {
    // The correction is about what she was LOOKING FOR, not about one image:
    // "no, the anchor is" is a verdict on a different render than the one that
    // said the smile was wrong. Constraining these to a single `render_name`
    // would have broken exactly the sequence this column exists to record.
    const first = addVerdict({ render: "syl-close-01" });
    const second = addVerdict({ render: "syl-close-02", supersedes: first });

    expect(
      db.prepare("SELECT render_name FROM render_verdicts WHERE id = ?").get(second),
    ).toEqual({ render_name: "syl-close-02" });
  });

  it("should keep the whole chain readable in order, oldest first", () => {
    // The property the epic is for: four orphans of equal weight become a
    // sequence in which the last one killed the first. Being wrong in a
    // recorded, ordered way is how the search actually works.
    const one = addVerdict({ verdict: "The smile is the problem." });
    const two = addVerdict({ verdict: "No — solidity is.", supersedes: one });
    const three = addVerdict({ verdict: "No — the anchor is.", supersedes: two });
    const four = addVerdict({ verdict: "Confirmed: it was the anchor.", supersedes: three });

    const chain = db
      .prepare(
        `WITH RECURSIVE chain(id, supersedes, depth) AS (
           SELECT id, supersedes, 0 FROM render_verdicts WHERE id = ?
           UNION ALL
           SELECT v.id, v.supersedes, chain.depth + 1
             FROM render_verdicts v JOIN chain ON v.id = chain.supersedes
         )
         SELECT id FROM chain ORDER BY depth DESC`,
      )
      .all(four)
      .map((row) => (row as { id: string }).id);

    expect(chain).toEqual([one, two, three, four]);
  });

  it("should refuse to delete a verdict something else corrected", () => {
    // This store is append-only and nothing in the service deletes. The
    // reference makes that structural rather than a convention: a link cannot
    // be removed from the middle of a chain and leave the record still claiming
    // to be one.
    const first = addVerdict();
    addVerdict({ supersedes: first });

    expect(() => db.prepare("DELETE FROM render_verdicts WHERE id = ?").run(first)).toThrow();
  });

  it("should record the face a render was anchored on, and refuse a blank one", () => {
    const anchored = addVerdict({ anchorFace: "anchor-03.png" });

    expect(
      db.prepare("SELECT anchor_face FROM render_verdicts WHERE id = ?").get(anchored),
    ).toEqual({ anchor_face: "anchor-03.png" });
    // Blank is worse than absent: NULL says she did not record one, "" says she
    // recorded nothing and calls it an answer. `0030` refuses a blank verdict
    // for the same reason.
    expect(() => addVerdict({ anchorFace: "   " })).toThrow();
  });

  it("should answer 'what corrected this' from an index rather than a scan", () => {
    // The reverse direction is the one a reader walks — given a verdict, what
    // came after it — and it is the direction with no index unless one is
    // declared, because the column stores the OTHER end.
    const first = addVerdict();
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT id FROM render_verdicts WHERE supersedes = ?")
      .all(first)
      .map((row) => String((row as { detail: string }).detail))
      .join(" ")
      .toLowerCase();

    expect(plan).toContain("render_verdicts_supersedes_idx");
  });

  it("should still drop in one statement, taking its edges with it", () => {
    // The Commander's ruling, mechanised. When she settles on a likeness this
    // whole store goes, and it must go without unpicking anything else. An edge
    // in the memory graph would survive the drop and dangle — which is why
    // these are columns here and not `memory_edges` rows.
    const first = addVerdict();
    addVerdict({ supersedes: first, anchorFace: "anchor-03.png" });

    expect(() => db.exec("DROP TABLE render_verdicts")).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE sql LIKE '%render_verdicts%'")
        .get(),
    ).toEqual({ n: 0 });
  });
});
