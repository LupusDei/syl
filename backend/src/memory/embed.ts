/**
 * Local embeddings for the memory graph.
 *
 * Everything here runs on this machine. Constraint 1 in `CLAUDE.md` is
 * subscription payment rails and never the metered API, and a hosted embedding
 * endpoint billed per token is precisely the thing that constraint exists to
 * refuse — so the model is downloaded once and executed in-process, with no
 * credentials and no network at inference time.
 *
 * ## The two silent failures this module exists to prevent
 *
 * Both of them produce WORSE SEARCH RESULTS AND NO ERROR, which is why they are
 * pinned by tests rather than left to a call site's good intentions.
 *
 * **1. Prefix asymmetry.** EmbeddingGemma is trained with a different prefix for
 * a query than for a document. Embedding both sides the same way costs real
 * ranking quality and throws nothing. Measured here on 2026-08-09 with the
 * four-planet probe from the model card, at 256 dimensions: with the correct
 * query prefix the right document beat the runner-up 0.7441 to 0.6484, a margin
 * of 0.096; with the query prefix omitted the same comparison was 0.6812 to
 * 0.6488, a margin of 0.032. The right answer still won, but with a third of the
 * separation — the shape of failure that shows up as "search feels vague"
 * months later and is never traced back. `queryText` and `documentText` are the
 * only supported ways to build model input, and the literal strings are
 * asserted in `memory-embed.test.ts`.
 *
 * **2. Truncating a model that was not trained for it.** Matryoshka
 * Representation Learning packs the important dimensions first, so a trained
 * model can be cut to 256 and renormalised with its ranking intact. A model
 * WITHOUT that training degrades instead — again silently. So support is a
 * declared property of the model (`matryoshkaDimensions`), and asking for a
 * width that is not on the list throws.
 *
 * ## The platform pin — read this before "upgrading" anything
 *
 * This runs on an Intel iMac (`darwin-x64`), and the JavaScript ML ecosystem is
 * actively dropping that platform. `onnxruntime-node` shipped no `darwin-x64`
 * binary from **1.24.0** onward, and `@huggingface/transformers` depends on an
 * exact version — 4.2.0 pins `onnxruntime-node@1.24.3` — so npm installs it as
 * a NESTED copy and the whole thing dies at import with
 * `Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'`.
 *
 * A top-level dependency does not fix that, because the nested copy wins. The
 * fix is the `overrides` entry in the ROOT `package.json`, pinning
 * `onnxruntime-node` to `1.23.0` — the last release with a `darwin-x64` binary.
 * Both facts were re-verified by installing each version and importing it on
 * 2026-08-09. If that override is removed, this module stops working on this
 * machine and nowhere else; `explainLoadFailure` below turns the resulting
 * module-not-found into a sentence that says so.
 *
 * ## Device selection is per model, and measured
 *
 * The research pass recommended WebGPU for a 5.3x speedup. That does not hold
 * here, and the way it fails is worth recording:
 *
 * - Node 22 has no WebGPU. `navigator` exists, `navigator.gpu` does not.
 * - Asking Transformers.js for `device: "webgpu"` anyway does NOT throw. It
 *   quietly resolves to a different backend and runs at **17.2 chunks/sec** —
 *   less than half the CPU number below. A silent 2x slowdown from asking for
 *   the fast path.
 * - Measured on this machine, 120 chunks, EmbeddingGemma-300M:
 *   `q4` cpu batch=1 → 31.1/s, batch=8 → **36.7/s**, batch=32 → 36.1/s;
 *   `q8` cpu batch=1 → 5.3/s, batch=8 → 19.8/s, batch=32 → 31.4/s.
 *
 * So the 5.3x the research attributed to the GPU is reproduced on the CPU by
 * `q4` plus batching (5.3/s unbatched q8 → 36.7/s batched q4). The defaults
 * below are that configuration. `resolveDevice` refuses an explicit `webgpu`
 * request it cannot satisfy rather than degrading into the slow path without
 * saying anything.
 *
 * End to end through this module, warm, at the shipped defaults: **2,000 chunks
 * in 61.9s, 32.3 chunks/sec**, 256 dimensions out. The research pass predicted
 * 45.8s for the same 2,000 on the GPU it turned out we do not have; landing
 * within 35% of that on CPU alone is why the GPU is not worth chasing.
 *
 * ## What this module does not own
 *
 * Storage. `EMBEDDING_DIMENSIONS` is the width the vector table must be built
 * at — `vectorTableDdl` in `schema.ts` takes it as a parameter precisely so
 * this bead owns the number and the schema bead owns the partition key. Do not
 * hardcode 256 anywhere else.
 */

/** Thrown when embedding is asked for something it cannot do correctly. */
export class EmbeddingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

/** Execution backends we are willing to name. */
export type EmbeddingDevice = "cpu" | "webgpu";

/**
 * A quantisation the model actually supports.
 *
 * `fp16` is deliberately absent: EmbeddingGemma's activations do not support it
 * or its derivatives, per the model card. The type makes that a compile error
 * rather than a runtime surprise.
 */
export type EmbeddingDtype = "q4" | "q8" | "fp32";

/** Everything about a model that a caller must not have to guess. */
export interface EmbeddingModelSpec {
  /** Our short name for it, and its key in {@link EMBEDDING_MODELS}. */
  readonly id: string;
  /** The Hugging Face repo the weights come from. */
  readonly repo: string;
  /** Quantisation to load. */
  readonly dtype: EmbeddingDtype;
  /** The width the model emits before any truncation. */
  readonly nativeDimensions: number;
  /**
   * Widths this model was TRAINED to be truncated to, native width included.
   * Empty means the model is not a Matryoshka model and must never be cut.
   */
  readonly matryoshkaDimensions: readonly number[];
  /** The exact prefix a QUERY must carry. */
  readonly queryPrefix: string;
  /** The DOCUMENT prefix, with `{title}` as the only substitution. */
  readonly documentPrefix: string;
  /** What goes in the title slot when a document has no title. */
  readonly untitledTitle: string;
  /** The backend to use unless a caller overrides it. */
  readonly preferredDevice: EmbeddingDevice;
}

/**
 * EmbeddingGemma-300M.
 *
 * The prefixes are copied verbatim from the model card and re-checked on
 * 2026-08-09 against `onnx-community/embeddinggemma-300m-ONNX`. They look like
 * they could be tidied — they cannot. `"task: search result | query: "` keeps
 * its trailing space, and `"title: none | text: "` really does say the word
 * "none" when there is no title. Both are training-time strings; editing them
 * for neatness is the silent quality loss described at the top of this file.
 */
const EMBEDDING_GEMMA_300M: EmbeddingModelSpec = {
  id: "embeddinggemma-300m",
  repo: "onnx-community/embeddinggemma-300m-ONNX",
  // q4 rather than q8: measured nearly 7x faster unbatched on this CPU (31.1/s
  // against 5.3/s) and still faster batched, for a model whose quantised
  // checkpoints are QAT rather than post-hoc.
  dtype: "q4",
  nativeDimensions: 768,
  matryoshkaDimensions: [768, 512, 256, 128],
  queryPrefix: "task: search result | query: ",
  documentPrefix: "title: {title} | text: ",
  untitledTitle: "none",
  // Not webgpu. See the device note in this file's header: there is no WebGPU
  // in Node 22, and asking for it produces a silent 2x slowdown rather than an
  // error.
  preferredDevice: "cpu",
};

/** Every model we are prepared to run, by id. */
export const EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModelSpec>> = Object.freeze({
  [EMBEDDING_GEMMA_300M.id]: EMBEDDING_GEMMA_300M,
});

/** The model the memory graph uses. */
export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_GEMMA_300M.id;

/**
 * The width stored in the vector table.
 *
 * 256 of EmbeddingGemma's 768, which the model's Matryoshka training supports:
 * a third of the storage and a third of the distance arithmetic, with the
 * ranking held. Verified rather than assumed — `memory-embed-live.test.ts`
 * scores the model card's own four-document probe at 768, 512, 256 and 128 and
 * fails if the correct document stops winning at 256.
 *
 * This is the number `vectorTableDdl({ dimensions })` must be given. A vector
 * table built at a different width than the embedder writes is a corrupt store,
 * not a mismatch you notice.
 */
export const EMBEDDING_DIMENSIONS = 256;

/** How many texts go to the model in one call, unless a caller says otherwise. */
export const DEFAULT_BATCH_SIZE = 8;

/**
 * Look a model up by id.
 *
 * @throws {EmbeddingError} naming the ids that do exist.
 */
export function modelSpec(id: string): EmbeddingModelSpec {
  const found = EMBEDDING_MODELS[id];
  if (!found) {
    throw new EmbeddingError(
      `Unknown embedding model ${JSON.stringify(id)}. Known models: ${Object.keys(
        EMBEDDING_MODELS,
      ).join(", ")}.`,
    );
  }
  return found;
}

/** The default spec, resolved once. */
const DEFAULT_SPEC = modelSpec(DEFAULT_EMBEDDING_MODEL);

/**
 * A query, in the form the model was trained to receive it.
 *
 * Idempotent: text that already carries the prefix is returned unchanged, so a
 * caller that prefixes defensively does not end up embedding
 * `"task: search result | query: task: search result | query: mars"`.
 *
 * @throws {EmbeddingError} on empty or whitespace-only text — an empty
 * embedding is a vector that matches everything weakly, which is worse than a
 * failed write.
 */
export function queryText(text: string, model: EmbeddingModelSpec = DEFAULT_SPEC): string {
  const body = requireText(text, "A query");
  return body.startsWith(model.queryPrefix) ? body : `${model.queryPrefix}${body}`;
}

/** Optional per-document metadata that changes the prefix. */
export interface DocumentOptions {
  /** A title, if the document has one. Blank is treated as absent. */
  readonly title?: string;
}

/**
 * A document, in the form the model was trained to receive it.
 *
 * Note this is a DIFFERENT string from {@link queryText} for the same text, and
 * that asymmetry is the whole point.
 *
 * @throws {EmbeddingError} on empty or whitespace-only text.
 */
export function documentText(
  text: string,
  options: DocumentOptions = {},
  model: EmbeddingModelSpec = DEFAULT_SPEC,
): string {
  const body = requireText(text, "A document");
  const title = options.title?.trim();
  const prefix = model.documentPrefix.replace(
    "{title}",
    title && title.length > 0 ? title : model.untitledTitle,
  );
  return `${prefix}${body}`;
}

/**
 * Cut an embedding to `dimensions` and renormalise it to unit length.
 *
 * Renormalisation is not optional. Cosine similarity over unit vectors is a dot
 * product, and every consumer downstream assumes that; a truncated vector is
 * shorter than 1, so skipping this step makes similarity scores quietly
 * incomparable between rows written before and after.
 *
 * @throws {EmbeddingError} if the model declares no Matryoshka training, if the
 * width is not one it was trained for, if the input is not the native width, or
 * if the retained prefix is degenerate.
 */
export function truncateEmbedding(
  vector: readonly number[],
  dimensions: number,
  model: EmbeddingModelSpec = DEFAULT_SPEC,
): number[] {
  requireSupportedWidth(dimensions, model);

  if (vector.length !== model.nativeDimensions) {
    throw new EmbeddingError(
      `${model.id} emits ${model.nativeDimensions} dimensions, got a vector of ${vector.length}. ` +
        `Truncation is only meaningful on the model's own output.`,
    );
  }

  const kept = vector.slice(0, dimensions);
  let sumSquares = 0;
  for (const value of kept) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingError(
        `An embedding must be all finite numbers; got ${String(value)}. ` +
          `A NaN propagates into every similarity score it touches without failing anything.`,
      );
    }
    sumSquares += value * value;
  }

  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) {
    throw new EmbeddingError(
      `The first ${dimensions} dimensions of this embedding are all zero, so it cannot be ` +
        `normalised. A zero vector has no direction and would rank identically against everything.`,
    );
  }

  return kept.map((value) => value / magnitude);
}

/** What {@link resolveDevice} may be told. */
export interface DeviceOptions {
  /** Force a backend, overriding the model's preference. */
  readonly device?: EmbeddingDevice;
  /** Whether WebGPU exists. Injected so this is testable without a GPU. */
  readonly webgpuAvailable?: boolean;
}

/** The chosen backend, and — when it is not what was wanted — why. */
export interface ResolvedDevice {
  readonly device: EmbeddingDevice;
  /** True when the preference could not be honoured. */
  readonly fellBack: boolean;
  /** A sentence fit for a log line. */
  readonly reason: string;
}

/**
 * Whether this process can actually reach a GPU.
 *
 * Node 22 defines `navigator` but not `navigator.gpu`, so this is `false` on
 * the Commander's machine today. It is a function rather than a constant
 * because a future Node, or a polyfill loaded before us, could change the
 * answer within a single process's life.
 */
export function webgpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * Pick a backend, and never degrade one silently.
 *
 * A model's PREFERENCE may fall back — that is a preference. An EXPLICIT
 * request may not, because the reason to name a device by hand is that it
 * matters, and Transformers.js has already been observed accepting
 * `device: "webgpu"` on a machine with no WebGPU and running at half speed
 * without a word.
 *
 * @throws {EmbeddingError} when an explicit request cannot be satisfied.
 */
export function resolveDevice(
  model: EmbeddingModelSpec = DEFAULT_SPEC,
  options: DeviceOptions = {},
): ResolvedDevice {
  const gpu = options.webgpuAvailable ?? webgpuAvailable();

  if (options.device) {
    if (options.device === "webgpu" && !gpu) {
      throw new EmbeddingError(
        `webgpu was requested explicitly but this process has no navigator.gpu, so it cannot be ` +
          `honoured. Transformers.js would accept the request and run slower instead of failing, ` +
          `which is why this refuses. Ask for "cpu", or drop the option to take ${model.id}'s ` +
          `preference (${model.preferredDevice}).`,
      );
    }
    return { device: options.device, fellBack: false, reason: `${options.device} was requested explicitly.` };
  }

  if (model.preferredDevice === "webgpu" && !gpu) {
    return {
      device: "cpu",
      fellBack: true,
      reason:
        `${model.id} prefers webgpu, but this process has no navigator.gpu — Node 22 does not ` +
        `provide WebGPU — so it is running on cpu.`,
    };
  }

  return {
    device: model.preferredDevice,
    fellBack: false,
    reason: `${model.id} prefers ${model.preferredDevice}.`,
  };
}

/** The shape Transformers.js returns, narrowed to what we read. */
export interface ExtractorOutput {
  readonly dims: readonly number[];
  tolist(): number[][];
}

/**
 * The model, reduced to the one call we make.
 *
 * A function type rather than the library's own is what keeps every test in
 * `memory-embed.test.ts` offline: the download lives behind this seam and
 * nowhere else.
 */
export type Extractor = (texts: string[]) => Promise<ExtractorOutput>;

/** Loads the model. Injectable; the default one downloads. */
export type ExtractorLoader = (
  model: EmbeddingModelSpec,
  device: EmbeddingDevice,
  cacheDir?: string,
) => Promise<Extractor>;

/**
 * Where downloaded weights live.
 *
 * Transformers.js defaults to `node_modules/@huggingface/transformers/.cache`,
 * which means `npm ci` — or any dependency change that prunes the tree —
 * silently discards a few hundred megabytes that then have to be fetched again.
 * Setting `SYL_MODEL_CACHE_DIR` puts them somewhere `npm` does not own.
 */
export const MODEL_CACHE_DIR_ENV = "SYL_MODEL_CACHE_DIR";

/** The configured weights directory, or undefined to take the library default. */
export function modelCacheDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env[MODEL_CACHE_DIR_ENV]?.trim();
  return configured && configured.length > 0 ? configured : undefined;
}

/** How to build an embedder. */
export interface EmbedderOptions {
  /** Which model. Defaults to {@link DEFAULT_EMBEDDING_MODEL}. */
  readonly model?: EmbeddingModelSpec;
  /** Stored width. Defaults to {@link EMBEDDING_DIMENSIONS}. */
  readonly dimensions?: number;
  /** Texts per model call. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Force a backend. */
  readonly device?: EmbeddingDevice;
  /** Where weights live. Defaults to {@link modelCacheDir}. */
  readonly cacheDir?: string;
  /** Swap the model out. Tests inject; production leaves it alone. */
  readonly loadExtractor?: ExtractorLoader;
}

/** A document to embed, when it has a title. */
export interface DocumentInput extends DocumentOptions {
  readonly text: string;
}

/** Turns text into stored vectors. */
export interface Embedder {
  /** The model in use. */
  readonly model: EmbeddingModelSpec;
  /** The width every returned vector has. Feed this to `vectorTableDdl`. */
  readonly dimensions: number;
  /** Embed a search query, with the query prefix. */
  embedQuery(text: string): Promise<number[]>;
  /** Embed documents for storage, with the document prefix. */
  embedDocuments(documents: readonly (string | DocumentInput)[]): Promise<number[][]>;
  /** The backend actually in use, once the model has loaded. */
  device(): Promise<ResolvedDevice>;
}

/**
 * Build an embedder.
 *
 * The model is loaded lazily and exactly once — constructing this is cheap, and
 * a process that never searches never pays the several hundred megabytes.
 * Concurrent first calls share one load rather than racing two of them.
 *
 * @throws {EmbeddingError} immediately on an unusable width or batch size.
 * Validating at construction rather than at the first write is deliberate: the
 * alternative is discovering the store's width is wrong after rows exist in it.
 */
export function createEmbedder(options: EmbedderOptions = {}): Embedder {
  const model = options.model ?? DEFAULT_SPEC;
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const load = options.loadExtractor ?? loadTransformersExtractor;

  requireSupportedWidth(dimensions, model);
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new EmbeddingError(`A batch size must be a positive integer, got ${String(batchSize)}.`);
  }

  const resolved = resolveDevice(model, options.device ? { device: options.device } : {});

  const cacheDir = options.cacheDir ?? modelCacheDir();

  let pending: Promise<Extractor> | undefined;
  const extractor = (): Promise<Extractor> => {
    pending ??= load(model, resolved.device, cacheDir).catch((cause: unknown) => {
      // Reset so a transient failure does not poison the embedder forever.
      pending = undefined;
      throw explainLoadFailure(cause);
    });
    return pending;
  };

  const run = async (texts: string[]): Promise<number[][]> => {
    const model_ = await extractor();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const result = await model_(batch);
      const rows = result.tolist();
      if (rows.length !== batch.length) {
        throw new EmbeddingError(
          `Asked for ${batch.length} embeddings and got ${rows.length}. Rows are matched to ` +
            `inputs by position, so a short batch would silently attach the wrong vector to ` +
            `the wrong text.`,
        );
      }
      for (const row of rows) out.push(truncateEmbedding(row, dimensions, model));
    }
    return out;
  };

  return {
    model,
    dimensions,

    async embedQuery(text: string): Promise<number[]> {
      const [vector] = await run([queryText(text, model)]);
      if (!vector) throw new EmbeddingError("The model returned no embedding for the query.");
      return vector;
    },

    async embedDocuments(documents): Promise<number[][]> {
      if (documents.length === 0) return [];
      return run(
        documents.map((document) =>
          typeof document === "string"
            ? documentText(document, {}, model)
            : documentText(
                document.text,
                document.title === undefined ? {} : { title: document.title },
                model,
              ),
        ),
      );
    },

    async device(): Promise<ResolvedDevice> {
      await extractor();
      return resolved;
    },
  };
}

/**
 * The real loader: Transformers.js, imported only when a model is actually
 * wanted.
 *
 * The import is dynamic for two reasons. It keeps several hundred megabytes of
 * native runtime out of a process that never embeds anything — and on
 * `darwin-x64` a static import of a mispinned `onnxruntime-node` does not throw
 * an exception you can catch, it takes the process down at module load. Behind
 * a dynamic import the same failure is a rejected promise that
 * {@link explainLoadFailure} can turn into a useful sentence.
 */
const loadTransformersExtractor: ExtractorLoader = async (model, device, cacheDir) => {
  const { env, pipeline } = await import("@huggingface/transformers");
  if (cacheDir) env.cacheDir = cacheDir;
  const pipe = await pipeline("feature-extraction", model.repo, {
    dtype: model.dtype,
    device,
  });

  return async (texts) => {
    // Mean pooling and normalisation are what EmbeddingGemma's sentence-encoder
    // head expects; the model card's own example uses exactly this pair.
    // Normalising here AND again after truncation is not redundant — the second
    // one restores unit length that the cut takes away.
    const output = await pipe(texts, { pooling: "mean", normalize: true });
    return output as unknown as ExtractorOutput;
  };
};

/**
 * Turn a load failure into something that names the cause.
 *
 * The failure this is built for is the `darwin-x64` one: a bare
 * `Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'`
 * looks like a broken install, and the actual cause — a transitive exact pin on
 * a version that dropped this platform — is not something a reader can infer
 * from it. Anything else is passed through untouched.
 */
function explainLoadFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (message.includes("onnxruntime_binding.node") || message.includes("onnxruntime-node")) {
    return new EmbeddingError(
      `The ONNX runtime has no binary for this platform (${process.platform}-${process.arch}).\n` +
        `\n` +
        `onnxruntime-node dropped darwin-x64 in 1.24.0, and @huggingface/transformers depends on ` +
        `an EXACT version above that, which npm installs as a nested copy — so a top-level ` +
        `dependency does not help. The root package.json carries an "overrides" entry pinning ` +
        `onnxruntime-node to 1.23.0, the last release with a darwin-x64 binary. If that entry was ` +
        `removed or bumped, restore it and reinstall.\n` +
        `\n` +
        `Original: ${message}`,
      { cause },
    );
  }

  return cause instanceof Error ? cause : new EmbeddingError(message, { cause });
}

/** Shared width check, so construction and truncation cannot disagree. */
function requireSupportedWidth(dimensions: number, model: EmbeddingModelSpec): void {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new EmbeddingError(
      `An embedding width must be a positive integer, got ${String(dimensions)}.`,
    );
  }
  if (model.matryoshkaDimensions.length === 0) {
    throw new EmbeddingError(
      `${model.id} is not trained for Matryoshka truncation, so its ${model.nativeDimensions} ` +
        `dimensions must be stored whole. Cutting a model that was not trained for it degrades ` +
        `results without failing anything.`,
    );
  }
  if (!model.matryoshkaDimensions.includes(dimensions)) {
    throw new EmbeddingError(
      `${model.id} was trained for Matryoshka truncation at ${model.matryoshkaDimensions.join(
        ", ",
      )} dimensions, so ${dimensions} is refused. An untrained width loses ranking quality ` +
        `silently rather than raising anything.`,
    );
  }
}

/** Reject empty input rather than embedding it. */
function requireText(text: string, what: string): string {
  const body = text.trim();
  if (body.length === 0) {
    throw new EmbeddingError(
      `${what} must not be empty. An embedding of nothing is a direction in space that matches ` +
        `every stored row a little, which is worse than a write that fails.`,
    );
  }
  return body;
}
