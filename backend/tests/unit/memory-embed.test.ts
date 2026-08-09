import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODELS,
  EmbeddingError,
  MODEL_CACHE_DIR_ENV,
  createEmbedder,
  documentText,
  modelCacheDir,
  modelSpec,
  queryText,
  resolveDevice,
  truncateEmbedding,
  type EmbeddingModelSpec,
  type Extractor,
} from "../../src/memory/embed.js";

/**
 * These tests never touch the network and never load a model. Everything that
 * would download is behind the injected `loadExtractor` seam; the real one
 * lives in `memory-embed-live.test.ts`, which is opt-in.
 */

const spec = modelSpec(DEFAULT_EMBEDDING_MODEL);

/** A deterministic stand-in for the ONNX pipeline. */
function fakeExtractor(
  vectors: readonly number[][],
  seen?: { texts: string[][] },
): Extractor {
  let call = 0;
  return async (texts) => {
    seen?.texts.push([...texts]);
    const start = call;
    call += texts.length;
    const rows = vectors.slice(start, start + texts.length);
    return {
      dims: [rows.length, rows[0]?.length ?? 0],
      tolist: () => rows.map((row) => [...row]),
    };
  };
}

/** A vector of the model's native width whose first entry is `seed`. */
function nativeVector(seed: number, width = spec.nativeDimensions): number[] {
  return Array.from({ length: width }, (_, i) => (i === 0 ? seed : 1 / (i + 1)));
}

describe("memory/embed model registry", () => {
  it("should pin EmbeddingGemma's query prefix to the exact string from the model card", () => {
    // Verified 2026-08-09 against onnx-community/embeddinggemma-300m-ONNX.
    // A wrong prefix is a 5-15 point quality loss that throws nothing, so the
    // literal is pinned here rather than only being read from the spec.
    expect(spec.queryPrefix).toBe("task: search result | query: ");
  });

  it("should pin EmbeddingGemma's document prefix, which is a DIFFERENT string from the query prefix", () => {
    expect(spec.documentPrefix).toBe("title: {title} | text: ");
    expect(spec.untitledTitle).toBe("none");
    expect(spec.documentPrefix).not.toBe(spec.queryPrefix);
  });

  it("should declare 256 as a Matryoshka width the model was actually trained for", () => {
    expect(spec.matryoshkaDimensions).toContain(EMBEDDING_DIMENSIONS);
    expect(spec.nativeDimensions).toBe(768);
    expect(EMBEDDING_DIMENSIONS).toBe(256);
  });

  it("should refuse fp16, which EmbeddingGemma's activations do not support", () => {
    expect(spec.dtype).not.toBe("fp16");
    expect(["q4", "q8", "fp32"]).toContain(spec.dtype);
  });

  it("should return a spec for a known model id", () => {
    expect(modelSpec("embeddinggemma-300m").repo).toBe(
      "onnx-community/embeddinggemma-300m-ONNX",
    );
  });

  it("should throw naming the known ids when asked for a model that does not exist", () => {
    expect(() => modelSpec("nomic-embed-text")).toThrow(EmbeddingError);
    expect(() => modelSpec("nomic-embed-text")).toThrow(/embeddinggemma-300m/);
  });

  it("should expose every registered model under its own id", () => {
    for (const [id, entry] of Object.entries(EMBEDDING_MODELS)) {
      expect(entry.id).toBe(id);
    }
  });
});

describe("queryText", () => {
  it("should prefix a query with the model's query prefix", () => {
    expect(queryText("who is the Commander")).toBe(
      "task: search result | query: who is the Commander",
    );
  });

  it("should throw on text that is empty or only whitespace", () => {
    expect(() => queryText("   ")).toThrow(EmbeddingError);
    expect(() => queryText("")).toThrow(/empty/i);
  });

  it("should not prefix twice when the text already carries the prefix", () => {
    const once = queryText("mars");
    expect(queryText(once)).toBe(once);
  });

  it("should use the prefix of whichever model it is given", () => {
    const other: EmbeddingModelSpec = { ...spec, queryPrefix: "search: " };
    expect(queryText("mars", other)).toBe("search: mars");
  });
});

describe("documentText", () => {
  it("should prefix a document with the untitled document prefix", () => {
    expect(documentText("Mars is the Red Planet.")).toBe(
      "title: none | text: Mars is the Red Planet.",
    );
  });

  it("should put a supplied title into the prefix's title slot", () => {
    expect(documentText("Mars is red.", { title: "Planets" })).toBe(
      "title: Planets | text: Mars is red.",
    );
  });

  it("should fall back to the untitled form for a blank title", () => {
    expect(documentText("Mars is red.", { title: "   " })).toBe(
      "title: none | text: Mars is red.",
    );
  });

  it("should throw on text that is empty or only whitespace", () => {
    expect(() => documentText("\n\t ")).toThrow(EmbeddingError);
  });

  it("should produce a different string from queryText for the same text", () => {
    const text = "Mars is the Red Planet.";
    expect(documentText(text)).not.toBe(queryText(text));
  });
});

describe("truncateEmbedding", () => {
  it("should truncate to the requested width and renormalise to unit length", () => {
    const out = truncateEmbedding(nativeVector(3), 256);
    expect(out).toHaveLength(256);
    const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it("should keep the direction of the retained prefix", () => {
    const vector = nativeVector(3);
    const out = truncateEmbedding(vector, 256);
    // Ratios inside the kept prefix survive renormalisation.
    expect((out[1] ?? 0) / (out[2] ?? 1)).toBeCloseTo(
      (vector[1] ?? 0) / (vector[2] ?? 1),
      10,
    );
  });

  it("should return the native width unchanged in length when no truncation is asked for", () => {
    const out = truncateEmbedding(nativeVector(3), spec.nativeDimensions);
    expect(out).toHaveLength(spec.nativeDimensions);
  });

  it("should refuse a width the model was not trained for", () => {
    expect(() => truncateEmbedding(nativeVector(3), 300)).toThrow(EmbeddingError);
    expect(() => truncateEmbedding(nativeVector(3), 300)).toThrow(/Matryoshka/i);
  });

  it("should refuse to truncate a model that declares no Matryoshka support at all", () => {
    const plain: EmbeddingModelSpec = { ...spec, matryoshkaDimensions: [] };
    expect(() => truncateEmbedding(nativeVector(3), 256, plain)).toThrow(
      /not trained for Matryoshka/i,
    );
  });

  it("should refuse a vector that is not the model's native width", () => {
    expect(() => truncateEmbedding([1, 2, 3], 256)).toThrow(/768/);
  });

  it("should refuse a vector whose retained prefix has zero magnitude", () => {
    const zeros = new Array<number>(spec.nativeDimensions).fill(0);
    expect(() => truncateEmbedding(zeros, 256)).toThrow(/zero/i);
  });

  it("should refuse a vector containing a non-finite number", () => {
    const bad = nativeVector(3);
    bad[5] = Number.NaN;
    expect(() => truncateEmbedding(bad, 256)).toThrow(/finite/i);
  });
});

describe("modelCacheDir", () => {
  it("should return the configured directory", () => {
    expect(modelCacheDir({ [MODEL_CACHE_DIR_ENV]: "/var/syl/models" })).toBe("/var/syl/models");
  });

  it("should return undefined when nothing is configured, so the library default stands", () => {
    expect(modelCacheDir({})).toBeUndefined();
  });

  it("should treat a blank value as unset rather than as the current directory", () => {
    expect(modelCacheDir({ [MODEL_CACHE_DIR_ENV]: "   " })).toBeUndefined();
  });
});

describe("resolveDevice", () => {
  it("should use the model's preferred device when it is available", () => {
    const resolved = resolveDevice(spec, { webgpuAvailable: true });
    expect(resolved.device).toBe(spec.preferredDevice);
    expect(resolved.fellBack).toBe(false);
  });

  it("should fall back to cpu — and SAY so — when webgpu is asked for but absent", () => {
    const gpu: EmbeddingModelSpec = { ...spec, preferredDevice: "webgpu" };
    const resolved = resolveDevice(gpu, { webgpuAvailable: false });
    expect(resolved.device).toBe("cpu");
    expect(resolved.fellBack).toBe(true);
    expect(resolved.reason).toMatch(/navigator\.gpu/);
  });

  it("should honour an explicit device request over the model's preference", () => {
    const resolved = resolveDevice(spec, { device: "webgpu", webgpuAvailable: true });
    expect(resolved.device).toBe("webgpu");
  });

  it("should refuse an explicit webgpu request that cannot be satisfied rather than silently degrading it", () => {
    expect(() => resolveDevice(spec, { device: "webgpu", webgpuAvailable: false })).toThrow(
      EmbeddingError,
    );
  });
});

describe("createEmbedder", () => {
  it("should embed a query with the query prefix and truncate to 256 unit-length dimensions", async () => {
    const seen = { texts: [] as string[][] };
    const embedder = createEmbedder({
      loadExtractor: async () => fakeExtractor([nativeVector(1)], seen),
    });

    const vector = await embedder.embedQuery("who is the Commander");

    expect(seen.texts).toEqual([["task: search result | query: who is the Commander"]]);
    expect(vector).toHaveLength(256);
    expect(Math.sqrt(vector.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
  });

  it("should embed documents with the DOCUMENT prefix, not the query prefix", async () => {
    const seen = { texts: [] as string[][] };
    const embedder = createEmbedder({
      loadExtractor: async () => fakeExtractor([nativeVector(1), nativeVector(2)], seen),
    });

    await embedder.embedDocuments(["Mars is red.", "Venus is hot."]);

    expect(seen.texts).toEqual([
      ["title: none | text: Mars is red.", "title: none | text: Venus is hot."],
    ]);
  });

  it("should carry per-document titles into the prefix", async () => {
    const seen = { texts: [] as string[][] };
    const embedder = createEmbedder({
      loadExtractor: async () => fakeExtractor([nativeVector(1), nativeVector(2)], seen),
    });

    await embedder.embedDocuments(
      [
        { text: "Mars is red.", title: "Planets" },
        { text: "Venus is hot." },
      ],
    );

    expect(seen.texts).toEqual([
      ["title: Planets | text: Mars is red.", "title: none | text: Venus is hot."],
    ]);
  });

  it("should split a long list into batches of the configured size", async () => {
    const seen = { texts: [] as string[][] };
    const vectors = Array.from({ length: 5 }, (_, i) => nativeVector(i + 1));
    const embedder = createEmbedder({
      batchSize: 2,
      loadExtractor: async () => fakeExtractor(vectors, seen),
    });

    const out = await embedder.embedDocuments(["a", "b", "c", "d", "e"]);

    expect(seen.texts.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(out).toHaveLength(5);
    expect(out[0]).toHaveLength(256);
  });

  it("should return an empty array without loading the model when given no documents", async () => {
    const load = vi.fn(async () => fakeExtractor([]));
    const embedder = createEmbedder({ loadExtractor: load });

    expect(await embedder.embedDocuments([])).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("should load the model at most once across many calls", async () => {
    const load = vi.fn(async () =>
      fakeExtractor(Array.from({ length: 4 }, (_, i) => nativeVector(i + 1))),
    );
    const embedder = createEmbedder({ loadExtractor: load });

    await Promise.all([embedder.embedQuery("a"), embedder.embedQuery("b")]);
    await embedder.embedQuery("c");

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("should report the width it writes, so the vector table cannot be built at a different one", () => {
    const embedder = createEmbedder({ loadExtractor: async () => fakeExtractor([]) });
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(embedder.dimensions).toBe(256);
  });

  it("should surface the darwin-x64 onnxruntime pin as an explanation, not a bare module-not-found", async () => {
    const embedder = createEmbedder({
      loadExtractor: async () => {
        const error = new Error(
          "Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'",
        );
        (error as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
        throw error;
      },
    });

    await expect(embedder.embedQuery("a")).rejects.toThrow(/onnxruntime-node/);
    await expect(embedder.embedQuery("a")).rejects.toThrow(/1\.23\.0/);
  });

  it("should not swallow an unrelated load failure", async () => {
    const embedder = createEmbedder({
      loadExtractor: async () => {
        throw new Error("disk on fire");
      },
    });
    await expect(embedder.embedQuery("a")).rejects.toThrow(/disk on fire/);
  });

  it("should refuse output whose width is not the model's native width", async () => {
    const embedder = createEmbedder({
      loadExtractor: async () => fakeExtractor([[0.1, 0.2, 0.3]]),
    });
    await expect(embedder.embedQuery("a")).rejects.toThrow(/768/);
  });

  it("should refuse a batch that comes back with the wrong number of rows", async () => {
    const embedder = createEmbedder({
      loadExtractor: async () => fakeExtractor([nativeVector(1)]),
    });
    await expect(embedder.embedDocuments(["a", "b"])).rejects.toThrow(/2/);
  });

  it("should hand the configured cache directory to the loader", async () => {
    const seen: (string | undefined)[] = [];
    const embedder = createEmbedder({
      cacheDir: "/var/syl/models",
      loadExtractor: async (_model, _device, cacheDir) => {
        seen.push(cacheDir);
        return fakeExtractor([nativeVector(1)]);
      },
    });

    await embedder.embedQuery("a");

    expect(seen).toEqual(["/var/syl/models"]);
  });

  it("should reject a batch size that is not a positive integer", () => {
    expect(() => createEmbedder({ batchSize: 0, loadExtractor: async () => fakeExtractor([]) })).toThrow(
      EmbeddingError,
    );
  });

  it("should reject a requested width the model was not trained for, at construction rather than at write time", () => {
    expect(() =>
      createEmbedder({ dimensions: 300, loadExtractor: async () => fakeExtractor([]) }),
    ).toThrow(/Matryoshka/i);
  });
});
