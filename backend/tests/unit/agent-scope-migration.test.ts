import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  applyPragmas,
  IN_MEMORY,
  MIGRATIONS_DIR,
  readMigrations,
  type MigrationFile,
} from "../../src/services/database.js";
import { DatabaseSync, type Database } from "../../src/services/sqlite.js";

/**
 * The `agent` scope, tested as a **migration** rather than as a column.
 *
 * SQLite cannot widen a CHECK constraint in place, so `0015_agent_scope.sql`
 * rebuilds `api_keys`: new table, copy, drop, rename, recreate the indexes.
 * That is a far more dangerous operation than an `ALTER TABLE ADD COLUMN`, and
 * every way it can go wrong is silent:
 *
 * - a column dropped in the copy loses a paired device's expiry or revocation;
 * - a scope not carried across quietly *demotes* an admin key, or worse,
 *   promotes a device one;
 * - a **missed index** costs the single-use pairing guarantee, which lives in
 *   `api_keys_pairing_code_idx` being UNIQUE and nowhere else (`0011`).
 *
 * So this file applies the migrations up to the one before, writes rows through
 * the old schema, and then applies the rest — which is the only way to observe
 * a rebuild that discards something. A test against a fully-migrated database
 * would find an empty table and prove nothing.
 */

/** The version this bead took. See the file header of the migration itself. */
const AGENT_SCOPE_VERSION = 15;

let db: Database;
let migrations: readonly MigrationFile[];

/** Everything up to, but not including, the agent-scope migration. */
function before(): readonly MigrationFile[] {
  return migrations.filter((migration) => migration.version < AGENT_SCOPE_VERSION);
}

/** Write a key row directly, the way the pre-0015 schema accepted one. */
function insertKey(
  id: string,
  scope: string,
  overrides: { readonly pairingCodeId?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO api_keys
       (id, token_hash, token_suffix, device_name, scope, created_at, expires_at,
        last_used_at, revoked_at, revoked_reason, pairing_code_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `hash-${id}`,
    id.slice(-4),
    `Device ${id}`,
    scope,
    "2026-08-09T07:00:00.000Z",
    "2027-08-09T07:00:00.000Z",
    "2026-08-09T08:00:00.000Z",
    null,
    null,
    overrides.pairingCodeId ?? null,
  );
}

/** A redeemable pairing code row, so the foreign key has something to point at. */
function insertPairingCode(id: string): string {
  db.prepare(
    `INSERT INTO pairing_codes (id, code_hash, salt, issued_at, expires_at, redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "codehash",
    "salt",
    "2026-08-09T07:00:00.000Z",
    "2026-08-09T07:10:00.000Z",
    "2026-08-09T07:05:00.000Z",
  );
  return id;
}

/** The DDL SQLite is holding for a table, as it would replay it. */
function ddlOf(table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return String((row as { sql: string } | undefined)?.sql ?? "");
}

/** Every index on a table, with whether SQLite considers it unique. */
function indexesOf(table: string): ReadonlyMap<string, boolean> {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all();
  return new Map(
    rows.map((row) => {
      const typed = row as { name: string; unique: number };
      return [typed.name, typed.unique === 1];
    }),
  );
}

beforeEach(() => {
  db = new DatabaseSync(IN_MEMORY);
  applyPragmas(db, { busyTimeoutMs: 100, requireWal: false });
  migrations = readMigrations(MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
});

describe("0015_agent_scope", () => {
  it("should exist at the version this bead claimed, so a collision is a build failure", () => {
    // `readMigrations` refuses a gap in the sequence, which means a number
    // cannot be reserved ahead of a branch merging. If another branch lands
    // first, this assertion is what says so out loud rather than leaving two
    // files fighting over one version.
    const taken = migrations.find((migration) => migration.version === AGENT_SCOPE_VERSION);

    expect(taken?.filename).toBe("0015_agent_scope.sql");
  });

  it("should widen the CHECK constraint to admit `agent`", () => {
    applyMigrations(db, migrations);

    expect(() => insertKey("syl:apikey:agent-1", "agent")).not.toThrow();
  });

  it("should still refuse a scope the schema does not know", () => {
    // The rebuild must not lose the constraint it exists to widen. A typo has
    // to fail at the write: compared against a scope it does not match, an
    // unrecognised value denies access — which is safe, and then reads as a bug
    // in the middleware, which is expensive.
    applyMigrations(db, migrations);

    expect(() => insertKey("syl:apikey:typo", "Agent")).toThrow(/CHECK/iu);
    expect(() => insertKey("syl:apikey:typo2", "superuser")).toThrow(/CHECK/iu);
  });

  it("should leave every existing row on the scope it already had", () => {
    applyMigrations(db, before());
    insertKey("syl:apikey:device-1", "device");
    insertKey("syl:apikey:admin-1", "admin");

    applyMigrations(db, migrations);

    const rows = db.prepare("SELECT id, scope FROM api_keys ORDER BY id").all();
    expect(rows).toEqual([
      { id: "syl:apikey:admin-1", scope: "admin" },
      { id: "syl:apikey:device-1", scope: "device" },
    ]);
  });

  it("should carry every column across the rebuild, not merely the scope", () => {
    applyMigrations(db, before());
    const code = insertPairingCode("syl:pairing_code:1");
    insertKey("syl:apikey:device-1", "device", { pairingCodeId: code });
    db.prepare("UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(
      "2026-08-09T09:00:00.000Z",
      "left in a taxi",
      "syl:apikey:device-1",
    );

    applyMigrations(db, migrations);

    expect(db.prepare("SELECT * FROM api_keys").get()).toEqual({
      id: "syl:apikey:device-1",
      token_hash: "hash-syl:apikey:device-1",
      token_suffix: "ce-1",
      device_name: "Device syl:apikey:device-1",
      scope: "device",
      created_at: "2026-08-09T07:00:00.000Z",
      expires_at: "2027-08-09T07:00:00.000Z",
      last_used_at: "2026-08-09T08:00:00.000Z",
      revoked_at: "2026-08-09T09:00:00.000Z",
      revoked_reason: "left in a taxi",
      pairing_code_id: code,
    });
  });

  it("should keep the UNIQUE index that makes a pairing code single-use", () => {
    // `0011` puts the single-use guarantee in this index and says so: not in a
    // check-then-write in TypeScript, which a retry or a second process can
    // slip past. A rebuild that recreated the table and forgot the index would
    // remove that guarantee and break nothing visible until the day it mattered.
    applyMigrations(db, migrations);
    const code = insertPairingCode("syl:pairing_code:1");
    insertKey("syl:apikey:first", "device", { pairingCodeId: code });

    expect(indexesOf("api_keys").get("api_keys_pairing_code_idx")).toBe(true);
    expect(() => insertKey("syl:apikey:second", "device", { pairingCodeId: code })).toThrow(
      /UNIQUE/iu,
    );
  });

  it("should keep both of the other indexes the table was carrying", () => {
    applyMigrations(db, migrations);

    expect([...indexesOf("api_keys").keys()].sort()).toEqual(
      expect.arrayContaining([
        "api_keys_pairing_code_idx",
        "api_keys_revoked_created_idx",
        "api_keys_scope_idx",
      ]),
    );
  });

  it("should keep the table STRICT, its default, and its foreign key", () => {
    // Three properties that a rebuild loses by omission rather than by error.
    // STRICT is what refuses a wrong *type* before the CHECK ever sees a value;
    // the default is what `0014` used to leave every existing row weak; and the
    // foreign key is what lets a purged pairing code null itself out instead of
    // orphaning the key it granted.
    applyMigrations(db, migrations);
    const ddl = ddlOf("api_keys");

    expect(ddl).toMatch(/STRICT/u);
    expect(ddl).toMatch(/DEFAULT 'device'/u);
    expect(ddl).toMatch(/REFERENCES pairing_codes\s*\(\s*id\s*\)\s+ON DELETE SET NULL/u);
  });

  it("should leave a purged pairing code nulling the key rather than deleting it", () => {
    applyMigrations(db, migrations);
    const code = insertPairingCode("syl:pairing_code:1");
    insertKey("syl:apikey:first", "device", { pairingCodeId: code });

    db.prepare("DELETE FROM pairing_codes WHERE id = ?").run(code);

    expect(db.prepare("SELECT id, pairing_code_id FROM api_keys").all()).toEqual([
      { id: "syl:apikey:first", pairing_code_id: null },
    ]);
  });
});
