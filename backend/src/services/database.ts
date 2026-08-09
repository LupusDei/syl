import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync, type Database } from "./sqlite.js";

/**
 * Syl's operational store: one SQLite file, opened once, migrated on the way
 * up.
 *
 * Three separate failures are guarded here, and all three are silent in the
 * absence of a guard — which is why this module is larger than "open a file".
 *
 * 1. **A build that emits JavaScript and no SQL.** `tsc` does not copy `.sql`
 *    into `dist/`. The migration runner then finds an empty directory, applies
 *    nothing, and the service comes up against a database with no tables. This
 *    took Adjutant's server down. `readMigrations` refuses an empty directory
 *    and says why; `scripts/copy-assets.mjs` refuses to finish a build that
 *    copied nothing.
 * 2. **A pragma that quietly did not take.** `PRAGMA journal_mode = WAL`
 *    returns the mode actually in force rather than raising, so a filesystem
 *    that cannot do WAL leaves the database in rollback-journal mode with no
 *    error anywhere. `applyPragmas` reads every value back.
 * 3. **A migration that was edited after it shipped.** Two machines then hold
 *    different schemas while both believe they are at the same version. The
 *    ledger stores a checksum and the runner refuses to continue on a
 *    mismatch.
 */

/** The path that means "do not touch the disk". */
export const IN_MEMORY = ":memory:";

/**
 * The interactive conversation's id, as fixed by the contract.
 *
 * A constant, not a derivation: a client and a server that both use a constant
 * cannot disagree about which thread a message belongs to.
 */
export const INTERACTIVE_CONVERSATION_ID =
  "syl:conversation:00000000-0000-7000-8000-000000000001";

/**
 * Where the shipped `.sql` files live, resolved relative to this module rather
 * than to the working directory.
 *
 * Under `tsx` that is `src/migrations/`; in a build it is `dist/migrations/`,
 * which is exactly why the build has to copy them there.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** How long a writer waits for the lock before giving up. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** `NNNN_lower_snake_case.sql`, and nothing else. */
const MIGRATION_FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * A migration must not end the runner's transaction.
 *
 * The runner wraps each migration, and SQLite has no nested transactions, so a
 * `COMMIT` inside a file ends that transaction early: everything after it runs
 * unprotected, and a later failure leaves half the migration permanently
 * applied with no ledger row to show for it.
 *
 * `BEGIN` is deliberately **not** matched. SQLite rejects a nested `BEGIN`
 * loudly on its own, and — the reason that matters — `BEGIN` also opens a
 * trigger body, which the FTS5 index maintenance triggers need. Rejecting it
 * here would ban a construct the schema legitimately requires in order to
 * catch a mistake the engine already catches.
 *
 * Anchored to the start of a line, so `-- commit the seed row` in a comment is
 * not mistaken for the statement.
 */
const TRANSACTION_CONTROL = /^[ \t]*(commit|rollback|release)\b/im;

/** The migration ledger. Created before anything else, and by no migration. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  checksum   TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
) STRICT;
`;

/** Thrown when the schema cannot be brought to a known-good state. */
export class MigrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** One `.sql` file on disk, parsed and hashed. */
export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

/** One row of the ledger. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

/** What the connection settings actually became, read back from the engine. */
export interface PragmaReport {
  readonly journalMode: string;
  readonly synchronous: string;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
}

export interface ApplyPragmaOptions {
  readonly busyTimeoutMs?: number;
  /**
   * Whether to insist WAL took. True for a file database; false for
   * `:memory:`, which has no journal to write.
   */
  readonly requireWal?: boolean;
}

export interface OpenDatabaseOptions {
  /** A filesystem path, or {@link IN_MEMORY}. */
  readonly path: string;
  /** Defaults to {@link MIGRATIONS_DIR}. */
  readonly migrationsDir?: string;
  readonly busyTimeoutMs?: number;
  /** Injected so `applied_at` is assertable rather than "roughly now". */
  readonly now?: () => string;
}

/** An open, migrated database. */
export interface SylDatabase {
  readonly handle: Database;
  readonly path: string;
  readonly pragmas: PragmaReport;
  /** What this open applied. Empty when the schema was already current. */
  readonly applied: readonly AppliedMigration[];
  close(): void;
}

/**
 * Hash a migration's contents.
 *
 * Trailing whitespace is stripped first: editors add and remove a final
 * newline on their own, and a checksum that fails over one would turn a
 * harmless save into a refusal to boot.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\s+$/u, ""), "utf8").digest("hex");
}

/**
 * Read a version and name out of a filename, or `null` if it is not a
 * migration.
 *
 * Version zero is rejected so the sequence always starts at one and "how many
 * migrations exist" and "what is the newest version" are the same number.
 */
export function parseMigrationFilename(
  filename: string,
): { readonly version: number; readonly name: string } | null {
  const match = MIGRATION_FILENAME.exec(filename);
  if (match === null) return null;

  const [, digits, name] = match;
  if (digits === undefined || name === undefined) return null;

  const version = Number(digits);
  if (version < 1) return null;

  return { version, name };
}

/**
 * Load every migration in a directory, in order.
 *
 * @throws {MigrationError} if the directory is missing, holds no migrations,
 * holds a `.sql` file that does not follow the convention, repeats a version,
 * skips one, or contains a file that manages its own transaction.
 */
export function readMigrations(dir: string): readonly MigrationFile[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    throw new MigrationError(
      `Cannot read the migrations directory ${dir}. ` +
        `In a build this directory is populated by scripts/copy-assets.mjs, because tsc does not copy .sql files.`,
      { cause },
    );
  }

  const candidates = entries.filter((entry) => entry.endsWith(".sql")).sort();

  if (candidates.length === 0) {
    throw new MigrationError(
      `There are no migrations in ${dir}. ` +
        `Refusing to start against an unmigrated database: tsc does not copy .sql into dist/, ` +
        `so an empty directory here almost always means the asset copy step did not run.`,
    );
  }

  const byVersion = new Map<number, MigrationFile>();
  for (const filename of candidates) {
    const parsed = parseMigrationFilename(filename);
    if (parsed === null) {
      throw new MigrationError(
        `${filename} is not a valid migration name. Migrations are NNNN_lower_snake_case.sql, ` +
          `numbered from 0001. A file that does not match would be skipped silently, which is worse than this error.`,
      );
    }

    const existing = byVersion.get(parsed.version);
    if (existing !== undefined) {
      throw new MigrationError(
        `Two migrations claim version ${parsed.version}: ${existing.filename} and ${filename}.`,
      );
    }

    const sql = readFileSync(join(dir, filename), "utf8");
    if (TRANSACTION_CONTROL.test(sql)) {
      throw new MigrationError(
        `${filename} manages its own transaction. The runner wraps every migration, ` +
          `and SQLite has no nested transactions, so a COMMIT inside a migration commits half of it.`,
      );
    }

    byVersion.set(parsed.version, {
      version: parsed.version,
      name: parsed.name,
      filename,
      sql,
      checksum: checksumOf(sql),
    });
  }

  const migrations = [...byVersion.values()].sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `Gap in the migration sequence: expected version ${expected}, found ${migration.version} ` +
          `(${migration.filename}). A missing file is what a half-copied dist/ looks like.`,
      );
    }
  });

  return migrations;
}

/**
 * Read one column out of a `PRAGMA` result.
 *
 * `pragma` is interpolated because PRAGMA names cannot be bound as parameters.
 * It is safe here and must stay safe: this function is module-private and
 * every call site below passes a string literal. Do not export it, and do not
 * pass it anything that came from outside this file.
 */
function readPragma(db: Database, pragma: string, column: string): unknown {
  const row: unknown = db.prepare(`PRAGMA ${pragma}`).get();
  if (typeof row !== "object" || row === null) return undefined;
  // Safe assertion: a PRAGMA result row is a plain object of column values,
  // and the value is type-tested by every caller below.
  return (row as Record<string, unknown>)[column];
}

/** SQLite reports `synchronous` as an integer; these are its names. */
const SYNCHRONOUS_NAMES: readonly string[] = ["off", "normal", "full", "extra"];

/**
 * Put a connection into the settings Syl needs, and prove each one took.
 *
 * Every value is read back rather than assumed. `PRAGMA journal_mode` in
 * particular returns the mode actually in force instead of raising, so a
 * filesystem that cannot support WAL — a network mount, a sandbox — silently
 * leaves the database slower and less crash-safe than intended, with nothing
 * in any log to say so.
 *
 * @throws {MigrationError} if a setting did not take.
 */
export function applyPragmas(db: Database, options: ApplyPragmaOptions = {}): PragmaReport {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new MigrationError(`busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}.`);
  }

  // WAL first: readers stop blocking writers, which is what lets the job
  // runner write while the HTTP surface reads.
  db.exec("PRAGMA journal_mode = WAL");
  // NORMAL rather than FULL. With WAL this loses at most the last transactions
  // on a power cut and never corrupts, and the operational store is rebuilt
  // from the Commander's intent rather than being the only copy of it.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  const journalMode = String(readPragma(db, "journal_mode", "journal_mode") ?? "unknown");
  const synchronousCode = Number(readPragma(db, "synchronous", "synchronous"));
  const foreignKeys = Number(readPragma(db, "foreign_keys", "foreign_keys")) === 1;
  // The column is named `timeout`, not `busy_timeout`.
  const timeout = Number(readPragma(db, "busy_timeout", "timeout"));

  if ((options.requireWal ?? true) && journalMode !== "wal") {
    throw new MigrationError(
      `The database refused WAL and is in "${journalMode}" mode. ` +
        `Nothing raised, because PRAGMA journal_mode reports the mode in force instead of failing. ` +
        `A filesystem that cannot do WAL (often a network mount) is the usual cause.`,
    );
  }
  if (!foreignKeys) {
    throw new MigrationError("Foreign key enforcement is off; references would not be checked.");
  }

  const synchronous = SYNCHRONOUS_NAMES[synchronousCode] ?? String(synchronousCode);
  if (synchronous !== "normal") {
    throw new MigrationError(`PRAGMA synchronous did not take: it is "${synchronous}".`);
  }
  if (timeout !== busyTimeoutMs) {
    throw new MigrationError(
      `PRAGMA busy_timeout did not take: asked for ${busyTimeoutMs}, got ${timeout}.`,
    );
  }

  return { journalMode, synchronous, foreignKeys, busyTimeoutMs };
}

/** Read the ledger. */
function readLedger(db: Database): readonly AppliedMigration[] {
  const rows = db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all();

  return rows.map((row) => {
    // Safe assertion: the columns are ours, declared TEXT/INTEGER NOT NULL on
    // a STRICT table, so they cannot come back as anything else.
    const typed = row as {
      version: number;
      name: string;
      checksum: string;
      applied_at: string;
    };
    return {
      version: typed.version,
      name: typed.name,
      checksum: typed.checksum,
      appliedAt: typed.applied_at,
    };
  });
}

/**
 * Bring a database up to the schema the given migrations describe.
 *
 * Each migration runs inside one transaction together with its ledger row, so
 * a failure leaves no half-applied schema and no row claiming otherwise.
 *
 * @param now  produces the `applied_at` stamp. RFC 3339 UTC, like every other
 *             instant Syl stores.
 * @returns the migrations this call applied; empty if the schema was current.
 * @throws {MigrationError} on a checksum mismatch, an unknown applied version,
 * or a failing statement.
 */
export function applyMigrations(
  db: Database,
  migrations: readonly MigrationFile[],
  now: () => string = () => new Date().toISOString(),
): readonly AppliedMigration[] {
  db.exec(LEDGER_DDL);

  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const already = readLedger(db);

  for (const row of already) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      throw new MigrationError(
        `This database has migration ${row.version} (${row.name}) applied, but no such file ships with this build. ` +
          `That is a downgrade, and running the older code against the newer schema would corrupt it.`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.version} (${migration.filename}) has changed since it was applied: ` +
          `checksum ${row.checksum.slice(0, 12)} on disk, ${migration.checksum.slice(0, 12)} in the ledger. ` +
          `Edit forward with a new migration; never edit one that has shipped.`,
      );
    }
  }

  const appliedVersions = new Set(already.map((row) => row.version));
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  const applied: AppliedMigration[] = [];

  for (const migration of pending) {
    const record: AppliedMigration = {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      appliedAt: now(),
    };

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(record.version, record.name, record.checksum, record.appliedAt);
      db.exec("COMMIT");
    } catch (cause) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction was already gone. The original failure is the one
        // worth reporting, and swallowing this keeps it visible.
      }
      throw new MigrationError(`Migration ${migration.filename} failed and was rolled back.`, {
        cause,
      });
    }

    applied.push(record);
  }

  return applied;
}

/**
 * Open the operational store and bring its schema up to date.
 *
 * The migrations are read *before* the database is opened, so a build with no
 * SQL in it fails without having created an empty file that a later, fixed
 * build would then have to reason about.
 */
export function openDatabase(options: OpenDatabaseOptions): SylDatabase {
  const { path } = options;
  const migrations = readMigrations(options.migrationsDir ?? MIGRATIONS_DIR);

  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const handle = new DatabaseSync(path);
  try {
    const pragmaOptions: ApplyPragmaOptions = {
      busyTimeoutMs: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      requireWal: path !== IN_MEMORY,
    };
    const pragmas = applyPragmas(handle, pragmaOptions);
    const applied =
      options.now === undefined
        ? applyMigrations(handle, migrations)
        : applyMigrations(handle, migrations, options.now);

    return {
      handle,
      path,
      pragmas,
      applied,
      close: () => handle.close(),
    };
  } catch (error) {
    handle.close();
    throw error;
  }
}
