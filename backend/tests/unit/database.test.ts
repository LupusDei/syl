import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  applyPragmas,
  checksumOf,
  INTERACTIVE_CONVERSATION_ID,
  IN_MEMORY,
  MIGRATIONS_DIR,
  MigrationError,
  openDatabase,
  parseMigrationFilename,
  readMigrations,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/** A scratch directory that is removed after every test. */
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "syl-db-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a migration file into a fresh directory under the scratch root. */
function migrationsDir(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(scratch, "migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, "utf8");
  }
  return dir;
}

/** An in-memory database with the pragmas a real one would carry. */
function memoryDb(): Database {
  const db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  return db;
}

/** A fixed clock, so `applied_at` is assertable rather than "roughly now". */
const FIXED_NOW = "2026-08-09T04:00:00.000Z";
const fixedClock = (): string => FIXED_NOW;

describe("parseMigrationFilename", () => {
  it("should read the version and name from a conventional filename", () => {
    expect(parseMigrationFilename("0001_baseline.sql")).toEqual({
      version: 1,
      name: "baseline",
    });
  });

  it("should read a version well past the first", () => {
    expect(parseMigrationFilename("0042_add_message_fts.sql")).toEqual({
      version: 42,
      name: "add_message_fts",
    });
  });

  it("should reject a file with no numeric prefix", () => {
    expect(parseMigrationFilename("baseline.sql")).toBeNull();
  });

  it("should reject a file that is not .sql", () => {
    expect(parseMigrationFilename("0001_baseline.txt")).toBeNull();
  });

  it("should reject a name with characters that do not survive a shell or a diff", () => {
    expect(parseMigrationFilename("0001_Add Messages.sql")).toBeNull();
  });

  it("should reject version zero, so the sequence always starts at one", () => {
    expect(parseMigrationFilename("0000_nothing.sql")).toBeNull();
  });
});

describe("checksumOf", () => {
  it("should be stable for identical SQL", () => {
    expect(checksumOf("select 1;")).toBe(checksumOf("select 1;"));
  });

  it("should change when a single character changes", () => {
    expect(checksumOf("select 1;")).not.toBe(checksumOf("select 2;"));
  });

  it("should ignore a trailing newline, which editors add and remove at random", () => {
    expect(checksumOf("select 1;\n")).toBe(checksumOf("select 1;"));
  });
});

describe("readMigrations", () => {
  it("should return migrations sorted by version regardless of directory order", () => {
    const dir = migrationsDir({
      "0002_second.sql": "create table b (x int);",
      "0001_first.sql": "create table a (x int);",
    });

    const migrations = readMigrations(dir);

    expect(migrations.map((m) => m.version)).toEqual([1, 2]);
    expect(migrations.map((m) => m.name)).toEqual(["first", "second"]);
    expect(migrations[0]?.sql).toContain("create table a");
  });

  it("should refuse a directory holding no migrations at all, naming the asset-copy hazard", () => {
    const dir = migrationsDir({});

    expect(() => readMigrations(dir)).toThrow(MigrationError);
    // The failure this guards is a build that emitted JavaScript and no SQL.
    // The message has to say so, or the next person debugs an empty database.
    expect(() => readMigrations(dir)).toThrow(/no migrations/i);
    expect(() => readMigrations(dir)).toThrow(/copy/i);
  });

  it("should refuse a directory that does not exist", () => {
    expect(() => readMigrations(join(scratch, "absent"))).toThrow(MigrationError);
  });

  it("should refuse a .sql file that does not follow the naming convention", () => {
    const dir = migrationsDir({
      "0001_first.sql": "create table a (x int);",
      "quick_fix.sql": "create table b (x int);",
    });

    expect(() => readMigrations(dir)).toThrow(/quick_fix\.sql/);
  });

  it("should refuse two files claiming the same version", () => {
    const dir = migrationsDir({
      "0001_first.sql": "create table a (x int);",
      "0001_also_first.sql": "create table b (x int);",
    });

    expect(() => readMigrations(dir)).toThrow(/version 1/i);
  });

  it("should refuse a gap in the sequence, which is what a half-copied dist looks like", () => {
    const dir = migrationsDir({
      "0001_first.sql": "create table a (x int);",
      "0003_third.sql": "create table c (x int);",
    });

    expect(() => readMigrations(dir)).toThrow(/gap|expected version 2/i);
  });

  it("should refuse a migration that commits the runner's transaction out from under it", () => {
    const dir = migrationsDir({
      "0001_first.sql": "create table a (x int);\nCOMMIT;\ncreate table b (x int);",
    });

    expect(() => readMigrations(dir)).toThrow(/transaction/i);
  });

  it("should allow BEGIN, because it opens a trigger body as well as a transaction", () => {
    // The FTS5 index triggers in later migrations are written exactly like
    // this. Banning BEGIN to catch a nested transaction would ban the schema
    // instead — and SQLite rejects a genuine nested BEGIN on its own.
    const dir = migrationsDir({
      "0001_first.sql": [
        "create table a (x int);",
        "create trigger a_ai after insert on a",
        "BEGIN",
        "  select 1;",
        "END;",
      ].join("\n"),
    });

    expect(readMigrations(dir)).toHaveLength(1);
  });

  it("should not mistake the word commit inside a comment for the statement", () => {
    const dir = migrationsDir({
      "0001_first.sql": "-- commit the seed row below\ncreate table a (x int);",
    });

    expect(readMigrations(dir)).toHaveLength(1);
  });

  it("should ignore non-.sql files that happen to share the directory", () => {
    const dir = migrationsDir({
      "0001_first.sql": "create table a (x int);",
      "README.md": "# notes",
    });

    expect(readMigrations(dir).map((m) => m.version)).toEqual([1]);
  });
});

describe("applyPragmas", () => {
  it("should keep foreign keys enforced, set synchronous NORMAL and the busy timeout", () => {
    const db = new DatabaseSync(IN_MEMORY);

    const report = applyPragmas(db, { busyTimeoutMs: 4321, requireWal: false });

    expect(report.foreignKeys).toBe(true);
    expect(report.synchronous).toBe("normal");
    expect(report.busyTimeoutMs).toBe(4321);
    db.close();
  });

  it("should put a file database into WAL", () => {
    const db = new DatabaseSync(join(scratch, "wal.db"));

    const report = applyPragmas(db, { busyTimeoutMs: 100, requireWal: true });

    expect(report.journalMode).toBe("wal");
    db.close();
  });

  it("should refuse a busy timeout that is not a whole number of milliseconds", () => {
    const db = new DatabaseSync(IN_MEMORY);

    expect(() => applyPragmas(db, { busyTimeoutMs: 1.5, requireWal: false })).toThrow(
      /busyTimeoutMs/,
    );
    expect(() => applyPragmas(db, { busyTimeoutMs: -1, requireWal: false })).toThrow(
      /busyTimeoutMs/,
    );
    db.close();
  });

  it("should default the busy timeout rather than leaving it at SQLite's zero", () => {
    // SQLite's default is 0: a writer that meets a locked database fails
    // immediately instead of waiting, which under WAL turns ordinary
    // contention into SQLITE_BUSY.
    const db = new DatabaseSync(IN_MEMORY);

    const report = applyPragmas(db, { requireWal: false });

    expect(report.busyTimeoutMs).toBeGreaterThan(0);
    db.close();
  });

  it("should throw rather than accept a silent fallback out of WAL", () => {
    // An in-memory database can never be in WAL, so it stands in for the real
    // case: a filesystem (a network mount) where the pragma quietly no-ops.
    const db = new DatabaseSync(IN_MEMORY);

    expect(() => applyPragmas(db, { busyTimeoutMs: 100, requireWal: true })).toThrow(/WAL/);
    db.close();
  });
});

describe("applyMigrations", () => {
  it("should apply every pending migration in order and record it", () => {
    const db = memoryDb();
    const migrations = readMigrations(
      migrationsDir({
        "0001_first.sql": "create table a (x int);",
        "0002_second.sql": "create table b (x int);",
      }),
    );

    const applied = applyMigrations(db, migrations, fixedClock);

    expect(applied.map((m) => m.version)).toEqual([1, 2]);
    expect(applied[0]?.appliedAt).toBe(FIXED_NOW);
    expect(db.prepare("select count(*) as n from a").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from b").get()).toEqual({ n: 0 });
    db.close();
  });

  it("should do nothing on a second run against the same database", () => {
    const db = memoryDb();
    const migrations = readMigrations(
      migrationsDir({ "0001_first.sql": "create table a (x int);" }),
    );

    applyMigrations(db, migrations, fixedClock);
    const second = applyMigrations(db, migrations, fixedClock);

    expect(second).toEqual([]);
    db.close();
  });

  it("should apply only the migrations that are new", () => {
    const db = memoryDb();
    const first = readMigrations(
      migrationsDir({ "0001_first.sql": "create table a (x int);" }),
    );
    applyMigrations(db, first, fixedClock);

    const both = readMigrations(
      migrationsDir({
        "0001_first.sql": "create table a (x int);",
        "0002_second.sql": "create table b (x int);",
      }),
    );
    const applied = applyMigrations(db, both, fixedClock);

    expect(applied.map((m) => m.version)).toEqual([2]);
    db.close();
  });

  it("should refuse to run when an already-applied migration has been edited", () => {
    const db = memoryDb();
    applyMigrations(
      db,
      readMigrations(migrationsDir({ "0001_first.sql": "create table a (x int);" })),
      fixedClock,
    );

    const edited = readMigrations(
      migrationsDir({ "0001_first.sql": "create table a (x int, y int);" }),
    );

    expect(() => applyMigrations(db, edited, fixedClock)).toThrow(/checksum/i);
    db.close();
  });

  it("should refuse to run against a database migrated further than the files go", () => {
    const db = memoryDb();
    const both = readMigrations(
      migrationsDir({
        "0001_first.sql": "create table a (x int);",
        "0002_second.sql": "create table b (x int);",
      }),
    );
    applyMigrations(db, both, fixedClock);

    const onlyFirst = both.slice(0, 1);

    expect(() => applyMigrations(db, onlyFirst, fixedClock)).toThrow(/downgrade/i);
    expect(() => applyMigrations(db, onlyFirst, fixedClock)).toThrow(/migration 2/i);
    db.close();
  });

  it("should roll back the whole migration when one of its statements fails", () => {
    const db = memoryDb();
    const migrations = readMigrations(
      migrationsDir({
        "0001_first.sql": "create table a (x int);\ncreate table a (x int);",
      }),
    );

    expect(() => applyMigrations(db, migrations, fixedClock)).toThrow(MigrationError);

    // Neither the half-applied table nor a ledger row may survive.
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'a'")
      .all();
    expect(tables).toEqual([]);
    expect(db.prepare("select count(*) as n from schema_migrations").get()).toEqual({ n: 0 });
    db.close();
  });

  it("should name the migration that failed", () => {
    const db = memoryDb();
    const migrations = readMigrations(
      migrationsDir({ "0001_broken.sql": "this is not sql;" }),
    );

    expect(() => applyMigrations(db, migrations, fixedClock)).toThrow(/0001_broken/);
    db.close();
  });
});

describe("openDatabase", () => {
  it("should open, apply the shipped migrations and report what it applied", () => {
    const database = openDatabase({ path: IN_MEMORY });

    expect(database.applied.length).toBeGreaterThan(0);
    expect(database.applied[0]?.version).toBe(1);
    expect(database.path).toBe(IN_MEMORY);
    database.close();
  });

  it("should stamp applied_at from the clock it was given", () => {
    const database = openDatabase({ path: IN_MEMORY, now: fixedClock });

    expect(database.applied.every((m) => m.appliedAt === FIXED_NOW)).toBe(true);
    database.close();
  });

  it("should create the parent directory of a file database", () => {
    const path = join(scratch, "nested", "deeper", "syl.db");

    const database = openDatabase({ path });

    expect(existsSync(path)).toBe(true);
    expect(database.pragmas.journalMode).toBe("wal");
    database.close();
  });

  it("should be safe to open twice against the same file", () => {
    const path = join(scratch, "twice.db");

    const first = openDatabase({ path });
    first.close();
    const second = openDatabase({ path });

    expect(second.applied).toEqual([]);
    second.close();
  });

  it("should surface a migration failure rather than leaving a half-built database", () => {
    const dir = migrationsDir({ "0001_broken.sql": "this is not sql;" });

    expect(() => openDatabase({ path: IN_MEMORY, migrationsDir: dir })).toThrow(MigrationError);
  });

  it("should refuse to start when the migrations directory is empty", () => {
    const dir = join(scratch, "empty-migrations");
    mkdirSync(dir);

    expect(() => openDatabase({ path: IN_MEMORY, migrationsDir: dir })).toThrow(/no migrations/i);
  });
});

describe("the shipped schema", () => {
  it("should ship at least one migration next to the compiled module", () => {
    // This is the runtime half of the asset-copy guard. `tsc` does not copy
    // .sql files; if the build step that does is ever dropped, this fails here
    // rather than in production against an empty database.
    const migrations = readMigrations(MIGRATIONS_DIR);

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(1);
  });

  it("should seed the interactive conversation, so a message can never predate its thread", () => {
    const database = openDatabase({ path: IN_MEMORY });

    const row = database.handle
      .prepare("select id, lane, message_count from conversations where id = ?")
      .get(INTERACTIVE_CONVERSATION_ID);

    expect(row).toEqual({
      id: INTERACTIVE_CONVERSATION_ID,
      lane: "interactive",
      message_count: 0,
    });
    database.close();
  });

  it("should use the well-known interactive conversation id from the contract", () => {
    expect(INTERACTIVE_CONVERSATION_ID).toBe(
      "syl:conversation:00000000-0000-7000-8000-000000000001",
    );
  });

  it("should reject a conversation lane the contract does not define", () => {
    const database = openDatabase({ path: IN_MEMORY });

    expect(() =>
      database.handle
        .prepare(
          "insert into conversations (id, lane, created_at, updated_at) values (?, ?, ?, ?)",
        )
        .run("syl:conversation:x", "gossip", FIXED_NOW, FIXED_NOW),
    ).toThrow();
    database.close();
  });
});
