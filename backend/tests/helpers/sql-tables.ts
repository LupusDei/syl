import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "../../src/services/sqlite.js";

/**
 * Which tables the code actually talks to, read out of the code itself.
 *
 * A hand-maintained list of "tables Syl has" is a list that stops being true
 * the first time somebody adds a store and forgets the migration — which is
 * precisely the failure this exists to catch, so a list maintained by the same
 * hand that would forget cannot be the check.
 *
 * ## Why uppercase keywords are the discriminator
 *
 * The obvious approach — pull out string literals, keep the SQL-looking ones —
 * does not survive this codebase. `MessageStore.search` builds its column list
 * with a nested template literal inside a `${}`, so any regex that pairs
 * backticks loses the whole statement and, with it, `messages_fts`. It found
 * sixteen of the seventeen tables and silently dropped the seventeenth, which
 * is the worst possible outcome for a completeness check.
 *
 * Matching `FROM`/`JOIN`/`INTO`/`UPDATE` **case-sensitively in upper case**
 * needs no literal boundaries at all. Every SQL statement in `backend/src`
 * spells its keywords in upper case and every sentence of English prose spells
 * them in lower case, so the case alone separates the two populations. Comments
 * are stripped first anyway, which removes the only place the two would mix.
 */

/** Extensions worth reading. */
const SOURCE_EXTENSION = ".ts";

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
/** `//` to end of line, but never the `//` in a URL scheme. */
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;
const SQL_LINE_COMMENT = /--[^\n]*/g;

/** `FROM x`, `JOIN x`, `INSERT INTO x`, `UPDATE x`, `DELETE FROM x`. */
const TABLE_REFERENCE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/g;

/**
 * Words that follow one of those keywords without naming a table.
 *
 * `ON CONFLICT (...) DO UPDATE SET` is the one that actually occurs; the rest
 * are here so a future statement shape cannot smuggle a keyword in as a table.
 */
const NOT_A_TABLE: ReadonlySet<string> = new Set(["SET", "SELECT", "VALUES", "WHERE"]);

/**
 * Names bound by a `WITH ... AS (...)` clause.
 *
 * A common table expression is named exactly like a table and read exactly like
 * one — `FROM hits JOIN memory_nodes` — so the keyword scan cannot tell them
 * apart, and reports the CTE as a table no migration creates. That is a false
 * finding in the direction that matters most: this check exists to be believed,
 * and one entry nobody can act on is how a completeness list starts getting
 * exemptions added to it instead of bugs fixed.
 *
 * Anchored on `WITH` (and on `) ,` for the second and later expressions in a
 * chain) rather than on a bare `name AS (`. A looser pattern would eventually
 * match a column alias and EXCLUDE a real table, which fails silently — the one
 * direction this scanner must never fail in.
 *
 * **The column list is optional and that is not a loosening.** `WITH
 * day(label, opens, closes) AS (VALUES …)` is the ordinary way to name a
 * literal table inline, and `health/samples.ts` builds one per read to bucket
 * samples into HIS days. Without this the scanner reported `day` as a table no
 * migration creates — a finding nobody can act on, in a check whose whole value
 * is that it is believed. The anchor is unchanged, so `WITH name(…) AS (` is
 * still only ever matched where a CTE can actually be declared.
 */
const CTE_NAME =
  /(?:\bWITH\s+(?:RECURSIVE\s+)?|\)\s*,\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s*\(/g;

/**
 * SQLite's own schema tables.
 *
 * `sqlite_master` is queried by `memory/store.ts` to check the shape of a table
 * it may have to create. It always exists and no migration could create it —
 * the prefix is reserved by SQLite for exactly this class of thing.
 */
const SQLITE_INTERNAL = /^sqlite_/;

/** Where the service's own source lives. */
export const BACKEND_SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** Every `.ts` file under `dir`, recursively. */
export function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (extname(path) === SOURCE_EXTENSION) {
      found.push(path);
    }
  }
  return found;
}

/** One table, and the files whose SQL names it. */
export interface TableReference {
  readonly table: string;
  readonly files: readonly string[];
}

/**
 * Every table name the SQL in `dir` reads from or writes to.
 *
 * Sorted, so a failure message is stable between runs.
 */
export function referencedTables(dir: string = BACKEND_SRC): readonly TableReference[] {
  const byTable = new Map<string, Set<string>>();

  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, "utf8")
      .replace(BLOCK_COMMENT, " ")
      .replace(LINE_COMMENT, "$1")
      .replace(SQL_LINE_COMMENT, " ");

    // Per file, because a CTE name is only a CTE inside the statement that
    // binds it — and a name that is a CTE in one file may be a real table in
    // another.
    const cteNames = new Set(
      [...source.matchAll(CTE_NAME)].map((match) => match[1]).filter((name) => name !== undefined),
    );

    for (const match of source.matchAll(TABLE_REFERENCE)) {
      const name = match[1];
      if (name === undefined) continue;
      if (NOT_A_TABLE.has(name) && name === name.toUpperCase()) continue;
      if (cteNames.has(name)) continue;
      if (SQLITE_INTERNAL.test(name)) continue;

      const files = byTable.get(name) ?? new Set<string>();
      files.add(file.slice(dir.length));
      byTable.set(name, files);
    }
  }

  return [...byTable.entries()]
    .map(([table, files]) => ({ table, files: [...files].sort() }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

/** Every table and virtual table an open database actually has. */
export function existingTables(db: Database): ReadonlySet<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  // Safe assertion: `sqlite_master.name` is declared TEXT by SQLite itself.
  return new Set(rows.map((row) => (row as { name: string }).name));
}
