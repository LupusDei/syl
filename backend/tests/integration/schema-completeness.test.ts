import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IntakeStore } from "../../src/connections/intake-store.js";
import {
  MIGRATIONS_DIR,
  openDatabase,
  readMigrations,
  type SylDatabase,
} from "../../src/services/database.js";
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
 * A **finding, not a configuration** — every entry would be a store that
 * cannot work against a real database. It is empty, and the three tests below
 * are arranged so that it can only ever be temporarily non-empty: one fails if
 * a referenced table is missing and unlisted, one fails if a listed table now
 * exists, and one fails if a listed table is no longer queried.
 *
 * `syl-1o7` held all five intake tables here. `0008_intake.sql` creates them.
 */
const KNOWN_MISSING: ReadonlySet<string> = new Set([]);

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
    // Derived rather than hardcoded. The literal `[1 … 11]` this replaced made
    // every migration author edit a test in a file they had no other business
    // in — and with several agents adding migrations at once, the same line
    // conflicting is not a hypothetical.
    //
    // Still strict: the versions must be exactly the shipped set, contiguous
    // from one, and there must be at least as many as the day this floor was
    // written. A floor only ever rises, so it cannot rot the way the literal
    // did, and it keeps the assertion from going vacuous if `readMigrations`
    // ever came back empty.
    const shipped = readMigrations(MIGRATIONS_DIR).map((migration) => migration.version);
    const applied = db.applied.map((migration) => migration.version);

    expect(shipped.length).toBeGreaterThanOrEqual(12);
    expect(shipped).toEqual(shipped.map((_, index) => index + 1));
    expect(applied).toEqual(shipped);
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
   * This test used to assert `no such table: intake_sources` — every intake
   * unit test passed because `tests/helpers/intake.ts` executed
   * `INTAKE_SCHEMA_SQL` by hand first, and against the database the service
   * actually opens the very first call threw. The helper built the thing the
   * suite was meant to be checking.
   *
   * It now asserts the opposite, and it goes all the way down: a source, its
   * chunks, an extract, and the cascade that makes a purge a real hard delete.
   * A schema that exists but whose foreign keys were not enabled would pass a
   * `SELECT name FROM sqlite_master` check and fail this one.
   */
  it("should record a source, its chunks and its extracts", () => {
    const store = new IntakeStore({ db: db.handle });

    const { source, created } = store.create({
      url: "https://example.com/tidy-desks?utm_source=newsletter",
      channel: "link",
      requestedBy: "commander",
      retention: "ephemeral",
      retentionReason: "read once",
    });

    expect(created).toBe(true);
    expect(source.stage).toBe("fetch");
    expect(source.origin).toBe("untrusted");
    // The UNIQUE index on `canonical_url` is what makes submission idempotent,
    // and it only exists if the migration created it.
    expect(source.canonicalUrl).toBe("https://example.com/tidy-desks");
    expect(store.create({ ...source, requestedBy: "commander" }).created).toBe(false);

    store.putChunks(source.id, [{ index: 0, start: 0, end: 12, text: "A tidy desk." }]);
    store.putExtract({
      sourceId: source.id,
      chunkIndex: 0,
      start: 0,
      end: 12,
      retention: "ephemeral",
      extract: {
        summary: "A tidy desk correlates with fewer context switches.",
        claims: [],
        entities: [],
        definitions: [],
        passages: [],
        questions: [],
        instructionsFound: [],
      },
    });

    expect(store.chunks(source.id)).toHaveLength(1);
    expect(store.extracts(source.id)).toHaveLength(1);

    // `purge` deletes only the parent row and relies on `ON DELETE CASCADE`
    // plus `PRAGMA foreign_keys`. Both come from the migration.
    expect(store.purge(source.id)).toEqual({ chunks: 1, extracts: 1 });
    expect(store.chunks(source.id)).toEqual([]);
    expect(store.extracts(source.id)).toEqual([]);
  });

  it("should carry the mail cursor tables the poller deduplicates against", () => {
    // The two tables with no store of their own yet. They are queried by
    // `intake-email.ts`, so a migration that forgot them would be invisible
    // until the first poll.
    const present = existingTables(db.handle);

    expect([...present].filter((table) => table.startsWith("intake_")).sort()).toEqual([
      "intake_chunks",
      "intake_extracts",
      "intake_mail",
      "intake_mail_cursor",
      "intake_sources",
    ]);
  });
});
