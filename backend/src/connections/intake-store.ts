import { createHash } from "node:crypto";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { uuidv7 } from "../services/id.js";
import type { Database } from "../services/sqlite.js";
import type { DocumentChunk } from "./document.js";
import { asChunkExtract, type ChunkExtract } from "./extract.js";
import { expiryFor, isRetentionClass, type RetentionClass } from "./retention.js";

/**
 * Where ingested sources, their chunks and their extracts live.
 *
 * ## The provenance chain is a foreign key, not a convention
 *
 * Every chunk and every extract references its source with
 * `ON DELETE CASCADE`, and `PRAGMA foreign_keys` is on. That is what makes
 * {@link IntakeStore.purge} a real hard delete rather than a hopeful one: the
 * caller deletes a source and the database removes everything descended from
 * it, including rows written by code that has not been added yet.
 *
 * The alternative — remembering to delete the children — is the version that
 * works until the day somebody adds a fourth table.
 *
 * ## Idempotency is a unique index
 *
 * `canonical_url` is UNIQUE. Submitting the same link twice returns the source
 * that already exists rather than starting a second ladder, and it does so
 * under a constraint the database enforces rather than a check a race can slip
 * past. That is what makes every step of intake safe to retry.
 *
 * ## The schema is not yet a migration
 *
 * {@link INTAKE_SCHEMA_SQL} is the exact body of the migration this store
 * needs. It is **not** applied automatically: `backend/src/migrations/` belongs
 * to another lane, and two agents appending sequentially-numbered files to one
 * directory is a guaranteed conflict. Land it as the next free
 * `NNNN_intake.sql` and delete this note.
 */

/** The migration body this store requires. Verbatim, ready to be a `.sql` file. */
export const INTAKE_SCHEMA_SQL = `
CREATE TABLE intake_sources (
  id              TEXT    NOT NULL PRIMARY KEY,
  url             TEXT    NOT NULL,
  canonical_url   TEXT    NOT NULL UNIQUE,
  channel         TEXT    NOT NULL,
  requested_by    TEXT    NOT NULL,
  origin          TEXT    NOT NULL,
  retention_class TEXT    NOT NULL,
  retention_reason TEXT   NOT NULL,
  stage           TEXT    NOT NULL,
  title           TEXT,
  content_hash    TEXT,
  media_type      TEXT,
  bytes           INTEGER NOT NULL,
  chunk_count     INTEGER NOT NULL,
  failure         TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  expires_at      TEXT
) STRICT;

CREATE INDEX intake_sources_stage ON intake_sources (stage);
CREATE INDEX intake_sources_expires_at ON intake_sources (expires_at);

CREATE TABLE intake_chunks (
  source_id  TEXT    NOT NULL REFERENCES intake_sources (id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  start_off  INTEGER NOT NULL,
  end_off    INTEGER NOT NULL,
  body       TEXT    NOT NULL,
  PRIMARY KEY (source_id, idx)
) STRICT;

CREATE TABLE intake_extracts (
  id              TEXT    NOT NULL PRIMARY KEY,
  source_id       TEXT    NOT NULL REFERENCES intake_sources (id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  start_off       INTEGER NOT NULL,
  end_off         INTEGER NOT NULL,
  origin          TEXT    NOT NULL,
  retention_class TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  UNIQUE (source_id, chunk_index)
) STRICT;

-- Which intake emails have already been handled.
--
-- The key has to be ours. Marking a message read or labelling it in Gmail
-- would need the gmail.modify scope, which also grants send, and Syl is
-- never getting the ability to send as him for the sake of a checkbox. So the
-- provider's message id is recorded here instead, and a mail that arrives
-- twice through a re-poll is one submission.
CREATE TABLE intake_mail (
  message_id   TEXT    NOT NULL PRIMARY KEY,
  received_at  TEXT    NOT NULL,
  sender       TEXT    NOT NULL,
  subject      TEXT,
  disposition  TEXT    NOT NULL,
  link_count   INTEGER NOT NULL,
  processed_at TEXT    NOT NULL
) STRICT;

-- Where the incremental mail sync got to. One row per watched address.
CREATE TABLE intake_mail_cursor (
  address    TEXT NOT NULL PRIMARY KEY,
  history_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

/**
 * Where a source came from.
 *
 * This records *who asked*, and never *what the payload may do*. A link the
 * Commander forwarded himself is exactly as hostile as one Syl found.
 */
export type IntakeChannel = "link" | "email" | "share";

/**
 * The ladder. Each value is the step that has yet to run, so a crash resumes
 * by reading this column and doing that step again.
 */
export type IntakeStage = "fetch" | "read" | "graft" | "done" | "failed";

/** Stages from which nothing further will happen on its own. */
export const TERMINAL_STAGES: readonly IntakeStage[] = ["done", "failed"];

/** One ingested source. */
export interface IntakeSource {
  readonly id: string;
  /** As submitted. What the fetcher is given. */
  readonly url: string;
  /** The dedup key: normalised, tracking parameters removed. */
  readonly canonicalUrl: string;
  readonly channel: IntakeChannel;
  /** Who asked. An authorisation fact, never a trust fact. */
  readonly requestedBy: string;
  /** Always `"untrusted"`. Inherited by everything derived from this source. */
  readonly origin: "untrusted";
  readonly retention: RetentionClass;
  readonly retentionReason: string;
  readonly stage: IntakeStage;
  readonly title: string | null;
  readonly contentHash: string | null;
  readonly mediaType: string | null;
  readonly bytes: number;
  readonly chunkCount: number;
  /** Why this source stopped, if it did. */
  readonly failure: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When an `ephemeral` source becomes eligible for purge. */
  readonly expiresAt: string | null;
}

/** A validated extract, with the provenance that makes it traceable. */
export interface StoredExtract {
  readonly id: string;
  readonly sourceId: string;
  readonly chunkIndex: number;
  /** Offsets into the source's parsed text. */
  readonly start: number;
  readonly end: number;
  readonly origin: "untrusted";
  readonly retention: RetentionClass;
  readonly extract: ChunkExtract;
  readonly createdAt: string;
}

/** Query parameters that identify a campaign, not a document. */
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|igshid$|ref_src$|si$)/i;

/**
 * The form of a URL used for deduplication.
 *
 * Only the key is canonicalised — the fetch still uses the URL as submitted,
 * because a site that behaves differently without its query parameters is a
 * site whose content we would be guessing at.
 *
 * @throws {TypeError} if the input is not a URL.
 */
export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }

  const keep = [...url.searchParams.entries()].filter(([name]) => !TRACKING_PARAMS.test(name));
  url.search = "";
  // Sorted so `?a=1&b=2` and `?b=2&a=1` are one source rather than two.
  for (const [name, value] of keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    url.searchParams.append(name, value);
  }

  return url.toString();
}

/** `syl:source:<uuidv7>`, matching the contract's id pattern. */
export function newSourceId(generate: () => string = uuidv7): string {
  // `IdType` in services/id.ts does not list the intake types and that file
  // belongs to another lane; minted here rather than by editing it.
  return `syl:source:${generate()}`;
}

/** `syl:extract:<uuidv7>`. */
export function newExtractId(generate: () => string = uuidv7): string {
  return `syl:extract:${generate()}`;
}

/** SHA-256 of a fetched body, for noticing that a source changed. */
export function contentHashOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** What a submission needs before anything is fetched. */
export interface CreateSource {
  readonly url: string;
  readonly channel: IntakeChannel;
  readonly requestedBy: string;
  readonly retention: RetentionClass;
  readonly retentionReason: string;
}

/** Fields a step may move. Everything else about a source is immutable. */
export interface SourcePatch {
  readonly stage?: IntakeStage;
  readonly title?: string | null;
  readonly contentHash?: string | null;
  readonly mediaType?: string | null;
  readonly bytes?: number;
  readonly chunkCount?: number;
  readonly failure?: string | null;
}

interface SourceRow {
  readonly id: string;
  readonly url: string;
  readonly canonical_url: string;
  readonly channel: string;
  readonly requested_by: string;
  readonly origin: string;
  readonly retention_class: string;
  readonly retention_reason: string;
  readonly stage: string;
  readonly title: string | null;
  readonly content_hash: string | null;
  readonly media_type: string | null;
  readonly bytes: number;
  readonly chunk_count: number;
  readonly failure: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
}

const SOURCE_COLUMNS =
  "id, url, canonical_url, channel, requested_by, origin, retention_class, retention_reason, " +
  "stage, title, content_hash, media_type, bytes, chunk_count, failure, created_at, updated_at, expires_at";

/** Thrown when the store is asked for something that cannot be. */
export class IntakeStoreError extends Error {
  readonly kind: "unknown_source" | "bad_url" | "corrupt_row";

  constructor(kind: IntakeStoreError["kind"], message: string) {
    super(message);
    this.name = "IntakeStoreError";
    this.kind = kind;
  }
}

function toSource(row: SourceRow): IntakeSource {
  if (!isRetentionClass(row.retention_class)) {
    throw new IntakeStoreError(
      "corrupt_row",
      `Source ${row.id} has retention class "${row.retention_class}", which is not one Syl knows. ` +
        `Refusing to treat an unrecognised class as ordinary.`,
    );
  }
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    // Safe assertions: both columns are written only by this module, from the
    // closed unions above.
    channel: row.channel as IntakeChannel,
    requestedBy: row.requested_by,
    origin: "untrusted",
    retention: row.retention_class,
    retentionReason: row.retention_reason,
    stage: row.stage as IntakeStage,
    title: row.title,
    contentHash: row.content_hash,
    mediaType: row.media_type,
    bytes: row.bytes,
    chunkCount: row.chunk_count,
    failure: row.failure,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export interface IntakeStoreOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class IntakeStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: IntakeStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Record a submission, or hand back the one that already exists.
   *
   * Idempotent by canonical URL. The same link arriving twice — from the
   * Share Extension and again from a forwarded email — is one source.
   */
  create(input: CreateSource): { readonly source: IntakeSource; readonly created: boolean } {
    let canonical: string;
    try {
      canonical = canonicalUrl(input.url);
    } catch {
      throw new IntakeStoreError("bad_url", `${input.url} is not a URL Syl can record.`);
    }

    const existing = this.byCanonicalUrl(canonical);
    if (existing !== null) return { source: existing, created: false };

    const now = this.#clock();
    const at = instant(now);
    const source: IntakeSource = {
      id: newSourceId(),
      url: input.url,
      canonicalUrl: canonical,
      channel: input.channel,
      requestedBy: input.requestedBy,
      origin: "untrusted",
      retention: input.retention,
      retentionReason: input.retentionReason,
      stage: "fetch",
      title: null,
      contentHash: null,
      mediaType: null,
      bytes: 0,
      chunkCount: 0,
      failure: null,
      createdAt: at,
      updatedAt: at,
      expiresAt: expiryFor(input.retention, now),
    };

    this.#db
      .prepare(
        `INSERT INTO intake_sources (${SOURCE_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        source.url,
        source.canonicalUrl,
        source.channel,
        source.requestedBy,
        source.origin,
        source.retention,
        source.retentionReason,
        source.stage,
        source.title,
        source.contentHash,
        source.mediaType,
        source.bytes,
        source.chunkCount,
        source.failure,
        source.createdAt,
        source.updatedAt,
        source.expiresAt,
      );

    return { source, created: true };
  }

  /** One source by id, or `null`. */
  get(id: string): IntakeSource | null {
    const row = this.#db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM intake_sources WHERE id = ?`)
      .get(id);
    return row === undefined ? null : toSource(row as unknown as SourceRow);
  }

  /** One source by its canonical URL, or `null`. */
  byCanonicalUrl(canonical: string): IntakeSource | null {
    const row = this.#db
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM intake_sources WHERE canonical_url = ?`)
      .get(canonical);
    return row === undefined ? null : toSource(row as unknown as SourceRow);
  }

  /** Sources that still have a step to run, oldest first. */
  pending(): readonly IntakeSource[] {
    const rows = this.#db
      .prepare(
        `SELECT ${SOURCE_COLUMNS} FROM intake_sources
          WHERE stage NOT IN ('done', 'failed')
          ORDER BY created_at, id`,
      )
      .all();
    return rows.map((row) => toSource(row as unknown as SourceRow));
  }

  /** Move a source along. Returns the row as it now stands. */
  update(id: string, patch: SourcePatch): IntakeSource {
    const current = this.get(id);
    if (current === null) {
      throw new IntakeStoreError("unknown_source", `There is no intake source ${id}.`);
    }

    const next: IntakeSource = {
      ...current,
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.contentHash !== undefined ? { contentHash: patch.contentHash } : {}),
      ...(patch.mediaType !== undefined ? { mediaType: patch.mediaType } : {}),
      ...(patch.bytes !== undefined ? { bytes: patch.bytes } : {}),
      ...(patch.chunkCount !== undefined ? { chunkCount: patch.chunkCount } : {}),
      ...(patch.failure !== undefined ? { failure: patch.failure } : {}),
      updatedAt: instant(this.#clock()),
    };

    this.#db
      .prepare(
        `UPDATE intake_sources
            SET stage = ?, title = ?, content_hash = ?, media_type = ?, bytes = ?,
                chunk_count = ?, failure = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next.stage,
        next.title,
        next.contentHash,
        next.mediaType,
        next.bytes,
        next.chunkCount,
        next.failure,
        next.updatedAt,
        id,
      );

    return next;
  }

  /**
   * Replace a source's chunks.
   *
   * Replacing rather than appending is what makes the parse step idempotent:
   * a retry after a crash produces the same rows instead of a second copy.
   */
  putChunks(sourceId: string, chunks: readonly DocumentChunk[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM intake_chunks WHERE source_id = ?").run(sourceId);
      const insert = this.#db.prepare(
        "INSERT INTO intake_chunks (source_id, idx, start_off, end_off, body) VALUES (?, ?, ?, ?, ?)",
      );
      for (const chunk of chunks) {
        insert.run(sourceId, chunk.index, chunk.start, chunk.end, chunk.text);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Already unwound; the original failure is the one worth reporting.
      }
      throw error;
    }
  }

  /** A source's chunks, in order. */
  chunks(sourceId: string): readonly DocumentChunk[] {
    const rows = this.#db
      .prepare(
        "SELECT idx, start_off, end_off, body FROM intake_chunks WHERE source_id = ? ORDER BY idx",
      )
      .all(sourceId);

    return rows.map((row) => {
      // Safe assertion: the columns are ours, declared NOT NULL on a STRICT
      // table, so they cannot come back as anything else.
      const typed = row as unknown as {
        idx: number;
        start_off: number;
        end_off: number;
        body: string;
      };
      return { index: typed.idx, start: typed.start_off, end: typed.end_off, text: typed.body };
    });
  }

  /**
   * Record a validated extract for one chunk.
   *
   * Idempotent on `(source, chunk)`: re-reading a chunk after a crash replaces
   * the extract rather than adding a second one, so a resumed ladder converges
   * on the same store no matter where it was interrupted.
   */
  putExtract(input: {
    readonly sourceId: string;
    readonly chunkIndex: number;
    readonly start: number;
    readonly end: number;
    readonly retention: RetentionClass;
    readonly extract: ChunkExtract;
  }): StoredExtract {
    const stored: StoredExtract = {
      id: newExtractId(),
      sourceId: input.sourceId,
      chunkIndex: input.chunkIndex,
      start: input.start,
      end: input.end,
      origin: "untrusted",
      retention: input.retention,
      extract: input.extract,
      createdAt: instant(this.#clock()),
    };

    this.#db
      .prepare(
        `INSERT INTO intake_extracts
           (id, source_id, chunk_index, start_off, end_off, origin, retention_class, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, chunk_index) DO UPDATE SET
           start_off = excluded.start_off,
           end_off = excluded.end_off,
           retention_class = excluded.retention_class,
           body = excluded.body,
           created_at = excluded.created_at`,
      )
      .run(
        stored.id,
        stored.sourceId,
        stored.chunkIndex,
        stored.start,
        stored.end,
        stored.origin,
        stored.retention,
        JSON.stringify(stored.extract),
        stored.createdAt,
      );

    return stored;
  }

  /** A source's extracts, in chunk order. */
  extracts(sourceId: string): readonly StoredExtract[] {
    const rows = this.#db
      .prepare(
        `SELECT id, source_id, chunk_index, start_off, end_off, origin, retention_class, body, created_at
           FROM intake_extracts WHERE source_id = ? ORDER BY chunk_index`,
      )
      .all(sourceId);

    return rows.map((row) => {
      // Safe assertion: our own columns on a STRICT table.
      const typed = row as unknown as {
        id: string;
        source_id: string;
        chunk_index: number;
        start_off: number;
        end_off: number;
        retention_class: string;
        body: string;
        created_at: string;
      };
      if (!isRetentionClass(typed.retention_class)) {
        throw new IntakeStoreError(
          "corrupt_row",
          `Extract ${typed.id} has retention class "${typed.retention_class}".`,
        );
      }
      return {
        id: typed.id,
        sourceId: typed.source_id,
        chunkIndex: typed.chunk_index,
        start: typed.start_off,
        end: typed.end_off,
        origin: "untrusted",
        retention: typed.retention_class,
        // Re-validated on the way out, not merely parsed. A row edited on disk
        // is untrusted input arriving through a different door.
        extract: asChunkExtract(JSON.parse(typed.body)),
        createdAt: typed.created_at,
      };
    });
  }

  /**
   * Delete a source and everything descended from it.
   *
   * The cascade is the point. Deleting the parent row removes its chunks and
   * extracts because the foreign keys say so, which means a table added next
   * year is covered by the same call as long as it references the source.
   */
  purge(sourceId: string): { readonly chunks: number; readonly extracts: number } {
    const before = {
      chunks: this.chunks(sourceId).length,
      extracts: this.#countExtracts(sourceId),
    };
    this.#db.prepare("DELETE FROM intake_sources WHERE id = ?").run(sourceId);
    return before;
  }

  /** Purge every source whose retention window has closed. */
  purgeExpired(now: number = this.#clock()): readonly string[] {
    const at = instant(now);
    const rows = this.#db
      .prepare("SELECT id FROM intake_sources WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .all(at);

    // Safe assertion: a single TEXT NOT NULL column of our own.
    const ids = rows.map((row) => (row as unknown as { id: string }).id);
    for (const id of ids) this.purge(id);
    return ids;
  }

  #countExtracts(sourceId: string): number {
    const row = this.#db
      .prepare("SELECT count(*) AS n FROM intake_extracts WHERE source_id = ?")
      .get(sourceId);
    // Safe assertion: `count(*)` is always an integer.
    return (row as unknown as { n: number }).n;
  }
}
