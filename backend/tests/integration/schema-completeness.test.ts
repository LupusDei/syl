import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IntakeStore } from "../../src/connections/intake-store.js";
import { openDatabase, type SylDatabase } from "../../src/services/database.js";
import { existingTables, referencedTables } from "../helpers/sql-tables.js";

/**
 * Does a fresh, fully-migrated database have every table the code queries?
 *
 * Every store in this service has excellent unit tests, and every one of those
 * tests builds its own schema before it runs. That is the blind spot: a store
 * whose tables no migration creates passes its whole suite and then throws
 * `no such table` the first time it meets a real database. Nothing below this
 * file can see that, because each side is individually correct — the code is
 * right about what it queries and the migrations are right about what they
 * create, and only the join of the two is wrong.
 *
 * So this boots the real thing: `openDatabase` against a real file on disk,
 * which is also the only path that exercises WAL, and asks SQLite itself what
 * it ended up with.
 *
 * The database is a **file**, not `:memory:`. `applyPragmas` skips the WAL
 * assertion for in-memory databases, so an in-memory check would not be the
 * same boot the service performs.
 */

/**
 * Tables the code queries that no migration creates.
 *
 * This is a **finding, not a configuration**. Every entry is a store that
 * cannot work against a real database, listed here so the check below stays
 * able to catch the next one instead of being disabled by this one.
 *
 * `syl-1o7` — article intake (`IntakeStore`, `IntakeMailStore`) keeps its
 * schema in `INTAKE_SCHEMA_SQL` inside `intake-store.ts` and applies it only
 * from its own test helper. Migrations 0001–0007 create none of it.
 *
 * When the migration lands, delete the entry. The test fails if this set names
 * a table that now exists, so a stale exemption cannot outlive its fix.
 */
const KNOWN_MISSING: ReadonlySet<string> = new Set([
  "intake_sources",
  "intake_chunks",
  "intake_extracts",
  "intake_mail",
  "intake_mail_cursor",
]);

describe("a freshly migrated database", () => {
  let directory: string;
  let db: SylDatabase;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "syl-schema-"));
    db = openDatabase({ path: join(directory, "syl.db") });
  });

  afterAll(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("should apply every migration that ships, in order", () => {
    expect(db.applied.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(db.pragmas.journalMode).toBe("wal");
    expect(db.pragmas.foreignKeys).toBe(true);
  });

  it("should contain every table the service's SQL reads from or writes to", () => {
    const referenced = referencedTables();
    // The scanner finding nothing at all would make this test vacuously green,
    // which is the one way a completeness check can fail silently.
    expect(referenced.length).toBeGreaterThan(10);

    const present = existingTables(db.handle);
    const missing = referenced.filter(
      (reference) => !present.has(reference.table) && !KNOWN_MISSING.has(reference.table),
    );

    expect(
      missing.map((reference) => `${reference.table} (queried by ${reference.files.join(", ")})`),
    ).toEqual([]);
  });

  it("should have grown a table for every exemption that has since been fixed", () => {
    const present = existingTables(db.handle);
    const stale = [...KNOWN_MISSING].filter((table) => present.has(table));

    // A migration landed for one of the known gaps: take it off the list, so
    // the exemption cannot silently start covering a regression instead.
    expect(stale).toEqual([]);
  });

  it("should be queried only for tables that are in KNOWN_MISSING or really exist", () => {
    // Guards the exemption list against rot in the other direction: a table
    // named here that nothing queries any more is a line nobody will delete.
    const referenced = new Set(referencedTables().map((reference) => reference.table));
    const orphaned = [...KNOWN_MISSING].filter((table) => !referenced.has(table));

    expect(orphaned).toEqual([]);
  });
});

describe("syl-1o7 — article intake against a real migrated database", () => {
  let directory: string;
  let db: SylDatabase;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "syl-intake-"));
    db = openDatabase({ path: join(directory, "syl.db") });
  });

  afterAll(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * The seam, as behaviour rather than as schema.
   *
   * `intake-store.test.ts` passes because `tests/helpers/intake.ts` executes
   * `INTAKE_SCHEMA_SQL` by hand first. Against the database the service
   * actually opens, the very first call throws.
   *
   * Asserted as the specific SQLite error rather than as `it.fails`, so that
   * landing `0008_intake.sql` turns this red for a legible reason — and so
   * that a *different* break cannot masquerade as this known one.
   */
  it("should fail with 'no such table', naming the table the migration forgot", () => {
    const store = new IntakeStore({ db: db.handle });

    expect(() =>
      store.create({
        url: "https://example.com/tidy-desks",
        channel: "link",
        requestedBy: "commander",
        retention: "ephemeral",
        retentionReason: "read once",
      }),
    ).toThrow(/no such table: intake_sources/i);
  });
});
