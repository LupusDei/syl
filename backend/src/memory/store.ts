import { createRequire } from "node:module";

import { instant, systemClock, type Clock } from "../services/clock.js";
import type { Database } from "../services/sqlite.js";
import { EMBEDDING_DIMENSIONS } from "./embed.js";
import {
  SCANNED_TIER,
  nodePartition,
  vectorTableDdl,
  type MemoryNodeKind,
  type MemoryTier,
} from "./schema.js";

/**
 * The hybrid store: `vec0` vectors and an FTS5 keyword index over the same
 * nodes, plus the audit that proves they still describe the same graph.
 *
 * `0015_memory_retrieval.sql` is the argument for the keyword half and the
 * trust column; read it before changing anything here. `0012_memory_core.sql`
 * decided the partition key, and `vectorTableDdl()` in `schema.ts` is the only
 * route that decision takes to the vector table — this module never writes
 * `partition key` itself.
 *
 *
 * ## Two indexes, two mechanisms, and the honest reason they differ
 *
 * FTS5 is maintained by TRIGGERS, in the migration. `label` and `body` are
 * already in the row, so SQLite derives the index entry itself, inside the
 * writing transaction, and no code path can forget. Application code cannot
 * make it drift; only a missing migration can.
 *
 * `vec0` cannot work that way. An embedding is not derivable in SQL — it costs
 * a model call — so the vector table is written from here, by
 * {@link MemoryStore.putVector}, after the node exists. That is a genuinely
 * weaker guarantee than a trigger, and pretending otherwise is how a store ends
 * up half indexed. So it is bounded on three sides instead:
 *
 * 1. **One statement, one transaction.** Every write is delete-then-insert
 *    inside a SAVEPOINT, because `vec0` on 0.1.9 refuses `UPDATE` on a
 *    partition key column outright — verified, the error is
 *    *"UPDATE on partition key columns are not supported yet"*. A tier move is
 *    therefore a re-insert, and {@link MemoryStore.syncPartition} is the only
 *    correct way to perform one.
 * 2. **The partition is read from the node, never passed in.** `putVector`
 *    takes no tier and no kind. Handing them in is how a vector ends up in a
 *    partition its node has left, which prunes it out of every scan while the
 *    node is still hot — a memory that exists and cannot be found.
 * 3. **{@link MemoryStore.reconcile} names the drift.** Nodes with no vector,
 *    vectors with no node, and vectors whose partition no longer matches their
 *    node's. `syl-005.6.4` is the audit that proves nothing has become
 *    unreachable; this is the half of it this bead owns.
 *
 *
 * ## A partition key prunes SCANS, never IDENTITY LOOKUPS
 *
 * The same table as `graph.ts`, for the same reason:
 *
 * | Scans — hot tier only              | Identity lookups — every tier      |
 * | ---------------------------------- | ---------------------------------- |
 * | {@link MemoryStore.searchKeyword}  | {@link MemoryStore.vectorFor}      |
 * | {@link MemoryStore.searchVector}   | {@link MemoryStore.hasVector}      |
 * |                                    | {@link MemoryStore.putVector}      |
 * |                                    | {@link MemoryStore.removeVector}   |
 * |                                    | {@link MemoryStore.syncPartition}  |
 *
 * {@link VECTOR_IDENTITY_SQL} is pinned as an exported constant so a test can
 * assert that the text does not mention `tier`. A cold vector that cannot be
 * fetched by id is "prune, slowly, while claiming otherwise" — and here it is
 * worse than for an edge, because the repair (re-embedding) costs a model call
 * per node.
 *
 * Note that the keyword side has no identity column at all: FTS5 holds hot rows
 * ONLY, because it has no partition key and a tier predicate over a MATCH is a
 * post-filter over rows already read. A cold node is not keyword searchable and
 * is not meant to be — keyword search is a scan. See §1 of the migration.
 */

/** What went wrong, as a closed set a caller can branch on. */
export type StoreErrorKind =
  | "bad_limit"
  | "bad_vector"
  | "extension_unavailable"
  | "table_mismatch"
  | "unknown_node";

/** Thrown when the hybrid store cannot be built, read or written as asked. */
export class StoreError extends Error {
  readonly kind: StoreErrorKind;

  constructor(kind: StoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
    this.kind = kind;
  }
}

/** The `vec0` virtual table. Created here, not by a migration — see the header. */
export const VECTOR_TABLE = "memory_vectors";

/** The FTS5 index. Created by `0015_memory_retrieval.sql`. */
export const KEYWORD_TABLE = "memory_nodes_fts";

/**
 * The vector identity lookup, pinned as text.
 *
 * It does not mention `tier`, and a test asserts that it does not. `vec0`
 * prunes on any constrained subset of its partition keys, so adding one here
 * would work perfectly and quietly stop returning cold vectors. See the header.
 */
export const VECTOR_IDENTITY_SQL =
  `SELECT tier, kind, embedding FROM ${VECTOR_TABLE} WHERE node_id = ?`;

/** How many keyword or vector hits a scan returns when nobody says. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** One keyword hit. */
export interface KeywordHit {
  readonly nodeId: string;
  /**
   * FTS5's raw BM25. **Negative, and more negative is better** — it is the
   * negated score, so `ORDER BY bm25(...)` ascending is best-first. Passed
   * through unmapped; turning it into a [0, 1] relevance is `retrieve.ts`'s
   * job, because the mapping depends on the whole result set.
   */
  readonly bm25: number;
}

/** One vector hit. */
export interface VectorHit {
  readonly nodeId: string;
  /** `vec0`'s L2 distance, in [0, 2] for unit vectors. Lower is better. */
  readonly distance: number;
  /** Cosine similarity, recovered exactly. See {@link cosineFromL2}. */
  readonly similarity: number;
}

/** What a scan may be narrowed by. Both default to the hot tier. */
export interface SearchOptions {
  /** Defaults to `hot`. Anything else is an explicit look at what was set aside. */
  readonly tier?: MemoryTier;
  /** Narrow to one node kind. Prunes further on the secondary partition axis. */
  readonly kind?: MemoryNodeKind;
  readonly limit?: number;
}

/** Everything the two indexes disagree with the graph about. */
export interface StoreDrift {
  /** Hot nodes with no vector row. They are invisible to vector search. */
  readonly missingVectors: readonly string[];
  /** Vector rows whose node is gone. They can never be returned usefully. */
  readonly orphanVectors: readonly string[];
  /** Vectors in a partition their node has left. Pruned out of every scan. */
  readonly stalePartitions: readonly StalePartition[];
  /** Hot nodes absent from the keyword index. Only a missing trigger does this. */
  readonly missingKeyword: readonly string[];
  /** Keyword rows for nodes that are gone or no longer hot. */
  readonly orphanKeyword: readonly string[];
  /**
   * Vectors the graph has queued for a partition move that has not happened.
   *
   * Not a fault — it is work the store knows it owes, and ranked search is
   * already correct without it. Reported so a depth that never falls is
   * visible, which is what an undrained queue looks like.
   */
  readonly pendingReindex: number;
  /** True when every list above is empty. Excludes the queue, which is owed work. */
  readonly clean: boolean;
}

/** A vector whose partition no longer matches its node's. */
export interface StalePartition {
  readonly nodeId: string;
  readonly vector: { readonly tier: string; readonly kind: string };
  readonly node: { readonly tier: MemoryTier; readonly kind: MemoryNodeKind };
}

export interface MemoryStoreOptions {
  readonly db: Database;
  /**
   * The stored embedding width. Defaults to {@link EMBEDDING_DIMENSIONS}, which
   * `embed.ts` owns. A vector table built at a different width than the embedder
   * writes is a corrupt store rather than a mismatch anybody notices, so this is
   * checked against the table on every open.
   */
  readonly dimensions?: number;
  /** The `vec0` loadable extension. Defaults to {@link sqliteVecPath}. */
  readonly extensionPath?: string;
  readonly clock?: Clock;
}

const require_ = createRequire(import.meta.url);

/**
 * Where the `vec0` loadable extension lives on this machine.
 *
 * Resolved through Node's own module resolution rather than through
 * `sqlite-vec`'s exported `load()` helper, for the reason `services/sqlite.ts`
 * gives about `node:sqlite`: that helper uses `import.meta.resolve`, which the
 * test runner's bundler is entitled to rewrite. `createRequire` asks Node.
 *
 * @throws {StoreError} `extension_unavailable`, naming the platform, because
 * the failure this produces on an unsupported one is a missing optional
 * dependency and the bare resolution error does not say so.
 */
export function sqliteVecPath(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "windows" : platform;
  const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
  const specifier = `sqlite-vec-${os}-${arch}/vec0.${suffix}`;

  try {
    return require_.resolve(specifier);
  } catch (cause) {
    throw new StoreError(
      "extension_unavailable",
      `sqlite-vec has no loadable extension for ${platform}-${arch}: could not resolve ` +
        `${specifier}. It ships as an OPTIONAL dependency per platform, so npm installs ` +
        `nothing and reports success on a platform it does not cover — which is why this ` +
        `names the platform rather than passing the resolution error through. Keyword search ` +
        `still works without it; vector search does not.`,
      { cause },
    );
  }
}

/**
 * Load `vec0` into a connection.
 *
 * The connection must have been opened with `allowExtension: true` — there is
 * no way to grant that afterwards — so `openDatabase({ allowExtension: true })`
 * is a precondition rather than something this can arrange.
 *
 * Extension loading is switched back off immediately. One extension is wanted;
 * leaving the door open afterwards would make "this connection can load native
 * code" a lasting property of the process instead of a bounded moment.
 *
 * @returns the path that was loaded.
 * @throws {StoreError} `extension_unavailable`.
 */
export function loadSqliteVec(db: Database, extensionPath?: string): string {
  const path = extensionPath ?? sqliteVecPath();
  try {
    db.enableLoadExtension(true);
    db.loadExtension(path);
  } catch (cause) {
    throw new StoreError(
      "extension_unavailable",
      `Could not load the sqlite-vec extension from ${path}. A connection can only load ` +
        `extensions if it was opened with allowExtension: true, and node:sqlite offers no way ` +
        `to grant that afterwards — openDatabase({ allowExtension: true }) is what does it.`,
      { cause },
    );
  } finally {
    // In a `finally` so a failed load does not leave the door open either.
    db.enableLoadExtension(false);
  }
  return path;
}

/**
 * Cosine similarity recovered from `vec0`'s L2 distance.
 *
 * `vectorTableDdl()` declares a plain `float[n]` column, so the metric is L2 and
 * this module does not get to change that — the DDL belongs to `schema.ts`. It
 * does not need to: every stored vector is unit length, because
 * `truncateEmbedding` renormalises after the Matryoshka cut. For unit vectors
 *
 *     |a - b|^2 = 2 - 2 cos(a, b)     so     cos = 1 - d^2 / 2
 *
 * exactly, and the map is monotone decreasing, so L2 ranking and cosine ranking
 * are the same ranking. Verified against `vec0` 0.1.9: [1,0,0,0] against
 * [0.6,0.8,0,0] returns d = 0.8944271802902222, and 1 - d^2/2 = 0.6000000095790412.
 *
 * That residual is not error in this identity — it is `vec0` storing float32.
 * ~1e-8, eight orders of magnitude below any weight in the fusion formula, and
 * it cannot reorder two candidates that were not already tied. Stated because
 * "exact" was claimed here first and the test disagreed.
 *
 * Clamped to [0, 1] rather than [-1, 1]: a negative cosine is an
 * anti-correlated match, and letting it through would let a candidate SUBTRACT
 * from a fused relevance that two other channels voted for.
 */
export function cosineFromL2(distance: number): number {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new StoreError(
      "bad_vector",
      `A distance must be a finite, non-negative number, got ${String(distance)}.`,
    );
  }
  const cosine = 1 - (distance * distance) / 2;
  return cosine < 0 ? 0 : cosine > 1 ? 1 : cosine;
}

/**
 * An embedding, as the bytes `vec0` stores.
 *
 * Little-endian float32, written through a `DataView` rather than by handing
 * over a `Float32Array`'s buffer. `Float32Array` uses the platform's byte order
 * and sqlite-vec always reads little-endian; they agree on every machine this
 * runs on today and would disagree silently on one that is not.
 *
 * @throws {StoreError} `bad_vector` on the wrong width or a non-finite value. A
 * NaN in an embedding propagates into every distance it touches without failing
 * anything.
 */
export function encodeEmbedding(values: readonly number[], dimensions: number): Uint8Array {
  if (values.length !== dimensions) {
    throw new StoreError(
      "bad_vector",
      `This store holds ${dimensions}-dimensional embeddings and was given ${values.length}. ` +
        `A vector table written at a width the embedder does not produce is a corrupt store, ` +
        `not a mismatch anybody notices.`,
    );
  }

  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < dimensions; i += 1) {
    const value = values[i] as number;
    if (!Number.isFinite(value)) {
      throw new StoreError(
        "bad_vector",
        `An embedding must be all finite numbers; dimension ${i} was ${String(value)}.`,
      );
    }
    view.setFloat32(i * 4, value, true);
  }
  return bytes;
}

/** The inverse of {@link encodeEmbedding}. */
export function decodeEmbedding(bytes: Uint8Array): number[] {
  if (bytes.byteLength % 4 !== 0) {
    throw new StoreError(
      "bad_vector",
      `An embedding blob must be a whole number of float32 values; got ${bytes.byteLength} bytes.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let i = 0; i < bytes.byteLength; i += 4) values.push(view.getFloat32(i, true));
  return values;
}

/**
 * Turn what the Commander typed into an FTS5 MATCH expression.
 *
 * FTS5's query language has operators — `AND`, `OR`, `NOT`, `NEAR`, `*`, `^`,
 * `-`, `:` and quoting — so raw text is not a query, it is a program. "what did
 * he say about the Q3 review?" contains no operator and works; "syl-005: NEAR
 * or not" is a syntax error, and "review -notes" quietly means something the
 * person typing it did not ask for. Both failures are on the input path from a
 * human, so neither is hypothetical.
 *
 * Every token is therefore extracted as bare word characters and re-emitted as
 * a quoted phrase, which has no operator meaning at all.
 *
 * Joined with `OR`, not FTS5's implicit `AND`. Retrieval wants recall — BM25
 * already ranks a row matching four terms above one matching one, and a
 * conjunction turns one unusual word in a five-word question into an empty
 * result set.
 *
 * @returns the MATCH expression, or `null` if the text held no searchable
 * token — a distinct outcome from "no rows matched", and the caller must treat
 * it as the keyword channel being unavailable rather than as a score of zero.
 */
export function keywordQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(" OR ");
}

interface PartitionRow {
  readonly tier: string;
  readonly kind: string;
}

export class MemoryStore {
  readonly #db: Database;
  readonly #clock: Clock;

  /** The width every stored vector has. Feed this to the embedder. */
  readonly dimensions: number;

  /**
   * Open the hybrid store over an already-migrated database.
   *
   * Creating the `vec0` table is part of construction rather than a migration
   * because `vec0` does not exist until the extension is loaded, and a
   * migration that needed a loaded extension would make a database
   * un-openable on any machine sqlite-vec does not ship a binary for — for
   * every table, not just this one.
   *
   * An existing table is CHECKED rather than trusted: its stored DDL must be
   * the text `vectorTableDdl()` produces today. A table built at a different
   * width, or with a different partition key, would accept writes and return
   * wrong neighbours forever.
   *
   * @throws {StoreError} `extension_unavailable` if `vec0` is not loaded into
   * this connection, `table_mismatch` if a vector table exists in another
   * shape, `bad_vector` on an unusable width.
   */
  constructor(options: MemoryStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;

    this.#requireKeywordIndex();
    this.#ensureVectorTable();
  }

  // ── Scans: the hot tier, unless told otherwise ───────────────────────────

  /**
   * Keyword candidates, best first.
   *
   * A SCAN. The FTS5 index holds hot rows only — see §1 of
   * `0015_memory_retrieval.sql` — so a `tier` other than `hot` returns nothing
   * and says so by returning nothing rather than by pretending to have looked.
   * The option exists so the signature matches {@link searchVector} and a
   * caller cannot believe it partitions when it does not.
   *
   * `bm25` is passed through raw. Normalising it needs the whole result set,
   * which is `retrieve.ts`'s business.
   *
   * @throws {StoreError} `bad_limit`.
   */
  searchKeyword(text: string, options: SearchOptions = {}): KeywordHit[] {
    const limit = requireLimit(options.limit ?? DEFAULT_SEARCH_LIMIT);
    const tier = nodePartition(options.tier ?? SCANNED_TIER, options.kind ?? "fact").tier;
    if (tier !== SCANNED_TIER) return [];

    const match = keywordQuery(text);
    if (match === null) return [];

    // The join CONFIRMS each hit's tier against the node rather than trusting
    // the index. The triggers already guarantee the index holds hot rows only,
    // and this is deliberately the second lock on the same door: a superseded
    // memory served as though it were current is the failure `syl-005.3.3`
    // exists to prevent, and it would arrive here with nothing failing. It
    // costs one primary-key lookup per hit, not a scan.
    const conditions = [`f.${KEYWORD_TABLE} MATCH ?`, "n.tier = ?"];
    const bindings: (string | number)[] = [match, tier];
    if (options.kind !== undefined) {
      conditions.push("n.kind = ?");
      bindings.push(options.kind);
    }

    return this.#db
      .prepare(
        `SELECT f.node_id AS node_id, bm25(${KEYWORD_TABLE}, 0.0, 3.0, 1.0) AS score ` +
          `FROM ${KEYWORD_TABLE} f JOIN memory_nodes n ON n.id = f.node_id ` +
          `WHERE ${conditions.join(" AND ")} ORDER BY score, f.node_id LIMIT ?`,
      )
      .all(...bindings, limit)
      .map((row) => {
        const typed = row as unknown as { node_id: string; score: number };
        return { nodeId: typed.node_id, bm25: typed.score };
      });
  }

  /**
   * Nearest vectors, closest first.
   *
   * A SCAN, and the one place the partition key earns what `0012` paid for it:
   * `tier` is a `vec0` partition key column, so constraining it skips whole
   * chunks rather than filtering rows that have already been read. `kind`
   * narrows further on the secondary axis — `vec0` prunes on any constrained
   * subset of its partition keys.
   *
   * **Pruning is for cost; the join is for correctness, and it is not
   * redundant.** `vec0` 0.1.9 cannot `UPDATE` a partition key column, so a
   * vector does NOT follow its node between tiers on its own — a superseded
   * node whose vector has not been re-inserted yet still sits in the hot
   * partition and would be returned. Confirming each hit against its node's
   * real tier is what closes that window, and it costs one primary-key lookup
   * per returned hit rather than a scan. See §4 of the migration.
   *
   * **A search of a tier other than `hot` drains the reindex queue first**, and
   * that is not an optimisation. The confirming join makes a HOT search correct
   * with an undrained queue by dropping a stale vector; a COLD search fails the
   * other way, and silently. A node demoted a moment ago still has its vector
   * in the hot partition, so the cold KNN prunes it away and returns nothing —
   * and an empty result reads as "there is nothing there", not as "the repair
   * has not run". The cold-store audit (`syl-005.6.4`) exists to prove nothing
   * has become unreachable, so handing it a spurious unreachability finding
   * would be the worst possible failure of this method. Raised by graph-laws
   * against `syl-005.3.3`.
   *
   * @throws {StoreError} `bad_limit`, `bad_vector`.
   */
  searchVector(embedding: readonly number[], options: SearchOptions = {}): VectorHit[] {
    const limit = requireLimit(options.limit ?? DEFAULT_SEARCH_LIMIT);
    const partition = nodePartition(options.tier ?? SCANNED_TIER, options.kind ?? "fact");
    const blob = encodeEmbedding(embedding, this.dimensions);

    if (partition.tier !== SCANNED_TIER && this.pendingReindex() > 0) this.drainReindexQueue();

    const pruned = ["tier = ?"];
    const bindings: (string | Uint8Array | number)[] = [partition.tier];
    if (options.kind !== undefined) {
      pruned.push("kind = ?");
      bindings.push(options.kind);
    }

    const confirmed = ["n.tier = ?"];
    const afterBindings: (string | number)[] = [partition.tier];
    if (options.kind !== undefined) {
      confirmed.push("n.kind = ?");
      afterBindings.push(options.kind);
    }

    // The KNN is a CTE rather than a term in the join's WHERE clause: `k` is a
    // constraint `vec0` must see on its own table, and folding it into a join
    // invites the planner to choose an order in which it does not.
    //
    // There is deliberately NO `ORDER BY` in this statement. `vec0` inspects
    // the whole query and rejects one with *"Only a single 'ORDER BY distance'
    // clause is allowed on vec0 KNN queries"* — it counts the outer ordering
    // as a second one even though the CTE has none. The result set is at most
    // `limit` rows, so sorting them here costs nothing, and the tie-break on
    // `nodeId` makes the order total: two equidistant vectors would otherwise
    // swap between runs and make a fused ranking non-reproducible.
    return this.#db
      .prepare(
        `WITH hits AS (SELECT node_id, distance FROM ${VECTOR_TABLE} ` +
          `WHERE ${pruned.join(" AND ")} AND embedding MATCH ? AND k = ?) ` +
          `SELECT hits.node_id AS node_id, hits.distance AS distance FROM hits ` +
          `JOIN memory_nodes n ON n.id = hits.node_id WHERE ${confirmed.join(" AND ")}`,
      )
      .all(...bindings, blob, limit, ...afterBindings)
      .map((row) => {
        const typed = row as unknown as { node_id: string; distance: number };
        return {
          nodeId: typed.node_id,
          distance: typed.distance,
          similarity: cosineFromL2(typed.distance),
        };
      })
      .sort((a, b) => a.distance - b.distance || (a.nodeId < b.nodeId ? -1 : 1));
  }

  // ── Identity: every tier ─────────────────────────────────────────────────

  /**
   * One node's stored embedding, or `null`.
   *
   * An IDENTITY LOOKUP: it spans every tier. See {@link VECTOR_IDENTITY_SQL}.
   */
  vectorFor(nodeId: string): number[] | null {
    const row = this.#db.prepare(VECTOR_IDENTITY_SQL).get(nodeId);
    if (row === undefined) return null;
    return decodeEmbedding((row as unknown as { embedding: Uint8Array }).embedding);
  }

  /** Whether a node has a vector at all, in any tier. */
  hasVector(nodeId: string): boolean {
    return this.#vectorPartition(nodeId) !== null;
  }

  /**
   * Write a node's embedding, into the partition its node is actually in.
   *
   * Delete-then-insert inside a SAVEPOINT, and there is no version of this that
   * is an `UPDATE`: `vec0` 0.1.9 refuses `UPDATE` on a partition key column
   * with *"UPDATE on partition key columns are not supported yet"*, so a tier
   * move has to re-insert the row. Doing the delete and the insert as one
   * atomic step is what stops a crash between them from erasing a vector that
   * cost a model call.
   *
   * The tier and kind are READ FROM THE NODE and are not parameters. A vector
   * placed in a partition its node has left is pruned out of every scan while
   * the node is still hot — a memory that exists and is unfindable, which is
   * the exact failure the partition key was supposed to be safe against.
   *
   * @throws {StoreError} `unknown_node`, `bad_vector`.
   */
  putVector(nodeId: string, embedding: readonly number[]): void {
    const partition = this.#nodePartitionOrThrow(nodeId);
    const blob = encodeEmbedding(embedding, this.dimensions);

    this.#inSavepoint("syl_put_vector", () => {
      this.#db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE node_id = ?`).run(nodeId);
      this.#db
        .prepare(
          `INSERT INTO ${VECTOR_TABLE} (node_id, tier, kind, embedding) VALUES (?, ?, ?, ?)`,
        )
        .run(nodeId, partition.tier, partition.kind, blob);
    });
  }

  /**
   * Drop a node's vector.
   *
   * An IDENTITY path, so it reaches a cold or suppressed vector too. This is
   * the retraction case — an observation withdrawn, a node the Commander asked
   * to forget outright — and never the demotion case: **demotion moves a
   * vector, it does not delete one.** Use {@link syncPartition}.
   *
   * @returns whether a row was removed.
   */
  removeVector(nodeId: string): boolean {
    const removed = this.#db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE node_id = ?`).run(nodeId);
    return (removed.changes as number) > 0;
  }

  /**
   * Move a node's vector into the partition its node is now in.
   *
   * Call this after any tier change — the demotion sweep, a supersession, a
   * promotion. Nothing else keeps the vector table in step, because a trigger
   * cannot: the row has to be re-inserted with its embedding, and the embedding
   * lives only in the vector table itself.
   *
   * A no-op when the partition already agrees, so it is safe to call
   * unconditionally and cheap to call in a loop.
   *
   * @returns whether the vector moved.
   * @throws {StoreError} `unknown_node`.
   */
  syncPartition(nodeId: string): boolean {
    const node = this.#nodePartitionOrThrow(nodeId);
    const current = this.#vectorPartition(nodeId);
    if (current === null) return false;
    if (current.tier === node.tier && current.kind === node.kind) return false;

    const embedding = this.vectorFor(nodeId);
    if (embedding === null) return false;

    this.putVector(nodeId, embedding);
    return true;
  }

  /**
   * Move every vector the graph has queued for reindexing into its node's
   * partition.
   *
   * The queue is filled by a TRIGGER on every `tier` or `kind` change, so the
   * repair is owed by the store rather than remembered by whoever moved the
   * node. `syl-005.3.3`'s `supersedeNode` does not have to call anything, and
   * neither does the nightly demotion sweep — which is the point: an
   * instruction to call a hook is a behavioural guarantee, and this project
   * decided (see `index-guarantee.ts`) that the service holds the guarantees.
   *
   * Draining is not what makes ranked search correct — {@link searchVector}
   * confirms every hit against its node and is safe with a queue that has never
   * been drained. Draining is what makes a COLD search find the cold vector,
   * and what stops the queue growing forever.
   *
   * A queued node with no vector, or one that has since been deleted, is
   * dropped from the queue rather than retried: there is nothing to move.
   *
   * @param limit the most nodes to repair in one pass.
   * @returns how many vectors actually moved.
   */
  drainReindexQueue(limit = 500): number {
    const bound = requireLimit(limit);
    const queued = this.#db
      .prepare(`SELECT node_id FROM memory_vector_reindex ORDER BY queued_at, node_id LIMIT ?`)
      .all(bound)
      .map((row) => (row as unknown as { node_id: string }).node_id);

    let moved = 0;
    for (const nodeId of queued) {
      this.#inSavepoint("syl_drain_reindex", () => {
        // A node deleted since it was queued has nothing to repair, and the
        // foreign key would have taken the queue row with it anyway.
        const exists =
          this.#db.prepare("SELECT 1 AS ok FROM memory_nodes WHERE id = ?").get(nodeId) !==
          undefined;
        if (exists && this.syncPartition(nodeId)) moved += 1;
        this.#db.prepare(`DELETE FROM memory_vector_reindex WHERE node_id = ?`).run(nodeId);
      });
    }
    return moved;
  }

  /** How many vectors are waiting to be moved into their node's partition. */
  pendingReindex(): number {
    const row = this.#db.prepare(`SELECT count(*) AS c FROM memory_vector_reindex`).get();
    return (row as unknown as { c: number }).c;
  }

  // ── Audit ────────────────────────────────────────────────────────────────

  /**
   * Everything the two indexes disagree with the graph about.
   *
   * This exists because only ONE of the two indexes is maintained by the
   * engine. FTS5 is trigger-driven and can only drift if a migration is
   * missing, so its two lists are a cheap proof the triggers are installed. The
   * vector table is written by application code, and its three lists are the
   * real content: `syl-005.6.4` is the audit that proves nothing has become
   * unreachable, and this is the half of it that lives here.
   *
   * Every list is bounded by `limit` so an audit over a large graph reports a
   * sample rather than materialising the whole disagreement. `clean` is still
   * computed from whether anything was found at all.
   */
  reconcile(limit = 100): StoreDrift {
    const bound = requireLimit(limit);
    const ids = (sql: string, ...bindings: (string | number)[]): string[] =>
      this.#db
        .prepare(sql)
        .all(...bindings)
        .map((row) => (row as unknown as { node_id: string }).node_id);

    const missingVectors = ids(
      `SELECT n.id AS node_id FROM memory_nodes n ` +
        `LEFT JOIN ${VECTOR_TABLE} v ON v.node_id = n.id ` +
        `WHERE n.tier = ? AND v.node_id IS NULL ORDER BY n.id LIMIT ?`,
      SCANNED_TIER,
      bound,
    );

    const orphanVectors = ids(
      `SELECT v.node_id AS node_id FROM ${VECTOR_TABLE} v ` +
        `LEFT JOIN memory_nodes n ON n.id = v.node_id ` +
        `WHERE n.id IS NULL ORDER BY v.node_id LIMIT ?`,
      bound,
    );

    const stalePartitions = this.#db
      .prepare(
        `SELECT v.node_id AS node_id, v.tier AS v_tier, v.kind AS v_kind, ` +
          `n.tier AS n_tier, n.kind AS n_kind FROM ${VECTOR_TABLE} v ` +
          `JOIN memory_nodes n ON n.id = v.node_id ` +
          `WHERE v.tier <> n.tier OR v.kind <> n.kind ORDER BY v.node_id LIMIT ?`,
      )
      .all(bound)
      .map((row) => {
        const typed = row as unknown as {
          node_id: string;
          v_tier: string;
          v_kind: string;
          n_tier: string;
          n_kind: string;
        };
        const node = nodePartition(typed.n_tier, typed.n_kind);
        return {
          nodeId: typed.node_id,
          vector: { tier: typed.v_tier, kind: typed.v_kind },
          node: { tier: node.tier, kind: node.kind as MemoryNodeKind },
        };
      });

    const missingKeyword = ids(
      `SELECT n.id AS node_id FROM memory_nodes n ` +
        `WHERE n.tier = ? AND NOT EXISTS ` +
        `(SELECT 1 FROM ${KEYWORD_TABLE} f WHERE f.node_id = n.id) ORDER BY n.id LIMIT ?`,
      SCANNED_TIER,
      bound,
    );

    const orphanKeyword = ids(
      `SELECT f.node_id AS node_id FROM ${KEYWORD_TABLE} f ` +
        `WHERE NOT EXISTS ` +
        `(SELECT 1 FROM memory_nodes n WHERE n.id = f.node_id AND n.tier = ?) ` +
        `ORDER BY f.node_id LIMIT ?`,
      SCANNED_TIER,
      bound,
    );

    return {
      missingVectors,
      orphanVectors,
      stalePartitions,
      missingKeyword,
      orphanKeyword,
      pendingReindex: this.pendingReindex(),
      clean:
        missingVectors.length === 0 &&
        orphanVectors.length === 0 &&
        stalePartitions.length === 0 &&
        missingKeyword.length === 0 &&
        orphanKeyword.length === 0,
    };
  }

  /** When this store last spoke. Exposed so a caller can stamp an audit. */
  now(): string {
    return instant(this.#clock());
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #requireKeywordIndex(): void {
    const row = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(KEYWORD_TABLE);
    if (row === undefined) {
      throw new StoreError(
        "table_mismatch",
        `${KEYWORD_TABLE} does not exist. It is created by 0015_memory_retrieval.sql, so this ` +
          `database has not been migrated — and an unmigrated database is what a build that ` +
          `emitted JavaScript and no SQL looks like.`,
      );
    }
  }

  /**
   * Create the vector table, or prove the one already there is the right shape.
   *
   * The comparison is against `vectorTableDdl()`'s output with runs of
   * whitespace collapsed, so reformatting that function is not a schema change
   * while the width or the partition key would be.
   */
  #ensureVectorTable(): void {
    const ddl = vectorTableDdl({ table: VECTOR_TABLE, dimensions: this.dimensions });

    const row = this.#db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(VECTOR_TABLE);

    if (row === undefined) {
      try {
        this.#db.exec(ddl);
      } catch (cause) {
        throw new StoreError(
          "extension_unavailable",
          `Could not create ${VECTOR_TABLE}. The usual cause is that vec0 is not loaded into ` +
            `this connection: it is a loadable extension, so it must be opened with ` +
            `allowExtension: true and passed to loadSqliteVec() before a MemoryStore is built.`,
          { cause },
        );
      }
      return;
    }

    const found = normaliseSql((row as unknown as { sql: string }).sql);
    const wanted = normaliseSql(ddl);
    if (found !== wanted) {
      throw new StoreError(
        "table_mismatch",
        `${VECTOR_TABLE} already exists in a different shape, and it is not safe to use.\n` +
          `  on disk: ${found}\n` +
          `  wanted:  ${wanted}\n` +
          `A vector table at the wrong width accepts every write and returns wrong neighbours ` +
          `forever; one with a different partition key prunes a different set of rows from the ` +
          `one the graph considers live. Neither fails anything. The partition key is owned by ` +
          `vectorTableDdl() in memory/schema.ts and the width by EMBEDDING_DIMENSIONS in ` +
          `memory/embed.ts — change them there, and rebuild this table.`,
      );
    }
  }

  #nodePartitionOrThrow(nodeId: string): { tier: MemoryTier; kind: string } {
    // No tier predicate. Writing a vector for a cold node is legitimate — that
    // is what a re-embedding of superseded history is — and a tier predicate
    // here would refuse it as "unknown node".
    const row = this.#db.prepare(`SELECT tier, kind FROM memory_nodes WHERE id = ?`).get(nodeId);
    if (row === undefined) {
      throw new StoreError(
        "unknown_node",
        `${nodeId} is not a node in the memory graph, so there is nothing for this vector to ` +
          `be about. A vector row whose node does not exist can never be returned usefully.`,
      );
    }
    const typed = row as unknown as PartitionRow;
    return nodePartition(typed.tier, typed.kind);
  }

  #vectorPartition(nodeId: string): PartitionRow | null {
    const row = this.#db.prepare(VECTOR_IDENTITY_SQL).get(nodeId);
    return row === undefined ? null : (row as unknown as PartitionRow);
  }

  /**
   * Run a unit of work atomically, whether or not a transaction is already open.
   *
   * `BEGIN` would throw inside one — and the store is meant to be usable inside
   * a caller's own transaction, which is how a node and its vector are written
   * as one thing.
   */
  #inSavepoint(name: string, work: () => void): void {
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      work();
      this.#db.exec(`RELEASE ${name}`);
    } catch (error) {
      try {
        this.#db.exec(`ROLLBACK TO ${name}`);
        this.#db.exec(`RELEASE ${name}`);
      } catch {
        // The savepoint is already gone. The original failure is the one worth
        // reporting, and swallowing this keeps it visible.
      }
      throw error;
    }
  }
}

function requireLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new StoreError(
      "bad_limit",
      `A limit must be an integer of at least 1, got ${String(value)}.`,
    );
  }
  return value;
}

/** DDL text, compared for meaning rather than for layout. */
function normaliseSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").replace(/\s*;\s*$/u, "").trim();
}
