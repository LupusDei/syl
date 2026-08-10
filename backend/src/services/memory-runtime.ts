import type { SemanticNeighbour, SemanticProposer } from "../memory/dream/sweep.js";
import { createEmbedder, type Embedder, type EmbedderOptions } from "../memory/embed.js";
import type { MemoryGraph, MemoryNode } from "../memory/graph.js";
import { Retriever } from "../memory/retrieve.js";
import { MemoryStore, loadSqliteVec } from "../memory/store.js";
import { SupersessionLedger } from "../memory/supersede.js";
import { systemClock, type Clock } from "./clock.js";
import type { Database } from "./sqlite.js";

/**
 * The memory epic, assembled for the running service.
 *
 * Every module of `syl-005` had a green unit suite and no call site
 * (`syl-63n`). Two of them are the reason the wiring was left undone, and both
 * reasons are real:
 *
 * ## 1. Model weights must never be on the boot path
 *
 * `Retriever`'s overlap channel needs an `Embedder`, and the real one is a
 * 300M-parameter model — several hundred megabytes, fetched on first use.
 * A service that spent minutes downloading weights before it could answer
 * `/health` would have broken something far more important than memory: Syl
 * holds reminder-delivery guarantees, and those come first.
 *
 * `embed.ts` already solved this. `createEmbedder` validates its arguments
 * eagerly and loads the model lazily, exactly once, on the first `embedQuery`
 * or `embedDocuments`. So **constructing an embedder is free** and this module
 * does it without ceremony. What it must not do — and what
 * `tests/unit/memory-runtime.test.ts` asserts with an injected loader that
 * throws — is call the extractor. A normal `npm test` downloads nothing, on
 * the same `loadExtractor` / `SYL_EMBED_LIVE` seam the embedding tests
 * established.
 *
 * ## 2. `vec0` is native, and it can be missing
 *
 * `MemoryStore`'s constructor creates or validates the `vec0` virtual table,
 * which means the extension has to be loaded into the connection first —
 * and `sqlite-vec` ships its binaries as per-platform optional dependencies,
 * so "not installed" is a state that reports success from `npm install`. A
 * `new MemoryStore(...)` directly inside `bootstrap` would turn that into a
 * service that will not start.
 *
 * So the searchable half is built **lazily and memoised**, and
 * {@link MemoryRuntime.trySearchable} degrades to `null` with one logged line
 * rather than throwing. Losing search is bad. Losing reminders because search
 * is unavailable would be worse.
 *
 * ## What is eager
 *
 * {@link MemoryRuntime.ledger}. A `SupersessionLedger` is prepared statements
 * over a handle the caller already owns: it cannot fail and it cannot block,
 * so deferring it would buy nothing and would make supersession unavailable on
 * a machine with no `vec0` for no reason at all.
 */

/** Thrown when the searchable half of memory could not be assembled. */
export class MemoryRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryRuntimeError";
  }
}

/** The half of memory that needs `vec0` and, eventually, a model. */
export interface SearchableMemory {
  readonly store: MemoryStore;
  readonly retriever: Retriever;
  /** Its weights load on first use, not here. */
  readonly embedder: Embedder;
  /** The embedding kernel of the nightly sweep. */
  readonly semantic: SemanticProposer;
}

export interface MemoryRuntimeOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
  /**
   * Passed straight to `createEmbedder`. Tests inject `loadExtractor`;
   * production leaves it alone and gets the lazy, real one.
   */
  readonly embedderOptions?: EmbedderOptions;
  /** Substituted in tests. Defaults to {@link loadSqliteVec}. */
  readonly loadExtension?: (db: Database) => unknown;
  /** Where the one line about a machine with no vector search goes. */
  readonly warn?: (line: string, error: unknown) => void;
}

export class MemoryRuntime {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;
  readonly #embedderOptions: EmbedderOptions;
  readonly #loadExtension: (db: Database) => unknown;
  readonly #warn: (line: string, error: unknown) => void;

  /**
   * Supersession. Eager, because it is statements over a handle that already
   * exists — see this module's header.
   */
  readonly ledger: SupersessionLedger;

  #searchable: SearchableMemory | null = null;
  #failure: Error | null = null;
  /** The failure already reported, so a broken machine says so once. */
  #announced: string | null = null;

  constructor(options: MemoryRuntimeOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
    this.#embedderOptions = options.embedderOptions ?? {};
    this.#loadExtension = options.loadExtension ?? ((db) => loadSqliteVec(db));
    this.#warn =
      options.warn ??
      ((line, error) => {
        console.error(`[syl] ${line}`, error);
      });

    this.ledger = new SupersessionLedger({
      db: options.db,
      graph: options.graph,
      clock: this.#clock,
    });
  }

  /** Whether the searchable half has been built successfully. */
  get ready(): boolean {
    return this.#searchable !== null;
  }

  /** The last assembly failure, or `null`. For a probe, and for a log line. */
  get lastFailure(): Error | null {
    return this.#failure;
  }

  /**
   * The searchable half, built on first use and memoised after that.
   *
   * A failure is **not** memoised. `embed.ts` makes the same call for the same
   * reason: a transient one — a disk that was busy, a file being replaced by an
   * install — would otherwise disable vector search for the life of the
   * process, and the process is expected to run for weeks.
   *
   * @throws {MemoryRuntimeError} naming the underlying cause.
   */
  searchable(): SearchableMemory {
    if (this.#searchable !== null) return this.#searchable;

    try {
      this.#loadExtension(this.#db);
      const store = new MemoryStore({ db: this.#db, clock: this.#clock });
      const embedder = createEmbedder(this.#embedderOptions);
      const retriever = new Retriever({
        db: this.#db,
        store,
        graph: this.#graph,
        embedder,
        clock: this.#clock,
      });
      this.#searchable = {
        store,
        retriever,
        embedder,
        semantic: storeSemanticProposer({ store, embedder }),
      };
      this.#failure = null;
      this.#announced = null;
      return this.#searchable;
    } catch (cause) {
      const failure = new MemoryRuntimeError(
        `The searchable half of memory could not be assembled: ${describe(cause)} ` +
          `Vector and keyword search are unavailable; the graph, the weight law, the ` +
          `supersession ledger and the dream log are not affected.`,
        { cause },
      );
      this.#failure = failure;
      throw failure;
    }
  }

  /**
   * The searchable half, or `null`.
   *
   * For every caller that would rather be degraded than dead — which on this
   * service is all of them, because nothing about memory is worth taking
   * reminder delivery down for. Says so once, keyed on the cause, so a machine
   * that will never have `vec0` does not produce a line an hour forever.
   */
  trySearchable(): SearchableMemory | null {
    try {
      return this.searchable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.#announced !== message) {
        this.#announced = message;
        this.#warn(message, error instanceof Error ? (error.cause ?? error) : error);
      }
      return null;
    }
  }
}

/** One line about a cause, ending in a full stop. */
function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.endsWith(".") ? message : `${message}.`;
}

export interface StoreSemanticProposerOptions {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
}

/**
 * The embedding kernel of the nightly sweep, over the real store.
 *
 * `dream/sweep.ts` declares `SemanticProposer` as an interface and names this
 * function as the production wiring, precisely so that module stays unit
 * testable without a 300M-parameter model in the room.
 *
 * **The seed's own stored vector is used when it has one**, and it almost
 * always does — a seed is a hot node the store has already indexed. That is not
 * only cheaper (a night sweeps up to `seedLimit` seeds and would otherwise pay
 * the model once each); it is more correct, because the probe then lives in
 * exactly the same space as everything it is compared against. Only a node that
 * has never been embedded falls back to embedding its text.
 *
 * The seed is filtered out of its own neighbours. `vec0` will always return it
 * first at distance zero, and a candidate edge from a node to itself is not a
 * proposal, it is noise — so one extra row is asked for and the seed dropped,
 * rather than the limit being quietly one short.
 *
 * **`kind` is deliberately not constrained.** It is the vector table's second
 * partition axis, so passing it would be faster — and would mean a `fact` could
 * only ever be proposed against another `fact`. "The gutter was replaced" and
 * "the roofer" are a `fact` and a `person`, and that connection is exactly the
 * kind of thing a night is for. The tier IS constrained, because a hot seed's
 * neighbours in the cold partition are by definition things the weight law has
 * already decided are not relevant.
 */
export function storeSemanticProposer(options: StoreSemanticProposerOptions): SemanticProposer {
  return {
    async near(node: MemoryNode, limit: number): Promise<readonly SemanticNeighbour[]> {
      if (limit < 1) return [];

      const stored = options.store.vectorFor(node.id);
      const probe = stored ?? (await options.embedder.embedQuery(probeTextFor(node)));

      return options.store
        .searchVector(probe, { tier: node.tier, limit: limit + 1 })
        .filter((hit) => hit.nodeId !== node.id)
        .slice(0, limit)
        .map((hit) => ({ nodeId: hit.nodeId, similarity: hit.similarity }));
    },
  };
}

/** What a node reads as, for a model that has never seen it. */
function probeTextFor(node: MemoryNode): string {
  return node.body === null || node.body.length === 0 ? node.label : `${node.label}\n${node.body}`;
}
