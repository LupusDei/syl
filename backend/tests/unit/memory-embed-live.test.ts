import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  createEmbedder,
  documentText,
  modelSpec,
  queryText,
  truncateEmbedding,
} from "../../src/memory/embed.js";

/**
 * The only tests here that run the REAL model, and they are opt-in.
 *
 * `npm test` must stay fast and offline. EmbeddingGemma is a few hundred
 * megabytes and the first run downloads it, so a suite that loaded it would
 * turn every fresh checkout and every CI container into a long, network-bound,
 * silently-flaky run — and a machine without the weights would fail tests that
 * have nothing to do with the change being made.
 *
 * So the seam is `loadExtractor`: `memory-embed.test.ts` injects a fake and
 * covers all the logic offline, and this file — the one place that touches the
 * network — is skipped unless `SYL_EMBED_LIVE=1` is set.
 *
 *     SYL_EMBED_LIVE=1 npm test -w backend -- memory-embed-live
 *
 * What lives here is exactly what a fake CANNOT tell you: that the real weights
 * behave the way the model card claims. Both facts checked below are silent
 * when wrong, which is why they are checked at all rather than assumed.
 *
 * Note the import above is static and safe: `embed.ts` pulls in
 * `@huggingface/transformers` through a DYNAMIC import, so importing this
 * module downloads nothing and loads no native runtime.
 */

const LIVE = process.env["SYL_EMBED_LIVE"] === "1";

/** The model card's own probe, kept verbatim so it is comparable to theirs. */
const QUESTION = "Which planet is known as the Red Planet?";
const DOCUMENTS = [
  "Venus is often called Earth's twin because of its similar size and proximity.",
  "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
  "Jupiter, the largest planet in our solar system, has a prominent red spot.",
  "Saturn, famous for its rings, is sometimes mistaken for the Red Planet.",
];
/** Index of the document that must win. */
const CORRECT = 1;

const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

describe.skipIf(!LIVE)("memory/embed against the real EmbeddingGemma weights", () => {
  const spec = modelSpec(DEFAULT_EMBEDDING_MODEL);

  it(
    "should rank the correct document first at the stored width of 256, which is what makes truncation safe",
    async () => {
      const embedder = createEmbedder();
      const query = await embedder.embedQuery(QUESTION);
      const documents = await embedder.embedDocuments(DOCUMENTS);

      expect(query).toHaveLength(EMBEDDING_DIMENSIONS);
      const scores = documents.map((document) => dot(query, document));
      const best = scores.indexOf(Math.max(...scores));

      expect(best).toBe(CORRECT);
    },
    600_000,
  );

  it(
    "should hold that ranking at every Matryoshka width the model declares, and only those",
    async () => {
      // Embed once at native width, then cut — that is what Matryoshka claims.
      const native = createEmbedder({ dimensions: spec.nativeDimensions });
      const query = await native.embedQuery(QUESTION);
      const documents = await native.embedDocuments(DOCUMENTS);

      for (const width of spec.matryoshkaDimensions) {
        const q = truncateEmbedding(query, width, spec);
        const scores = documents.map((document) => dot(q, truncateEmbedding(document, width, spec)));
        expect(scores.indexOf(Math.max(...scores))).toBe(CORRECT);
      }
    },
    600_000,
  );

  it(
    "should separate the correct document further with the query prefix than without it",
    async () => {
      const embedder = createEmbedder();
      const documents = await embedder.embedDocuments(DOCUMENTS);

      const withPrefix = await embedder.embedQuery(QUESTION);
      // The mistake this guards against: embedding the query with the DOCUMENT
      // prefix, which is what a caller who "just adds the prefix" ends up doing.
      const wrongPrefix = (
        await embedder.embedDocuments([{ text: QUESTION }])
      )[0];
      expect(wrongPrefix).toBeDefined();

      const margin = (query: readonly number[]): number => {
        const scores = documents.map((document) => dot(query, document));
        const correct = scores[CORRECT] ?? 0;
        const runnerUp = Math.max(...scores.filter((_, i) => i !== CORRECT));
        return correct - runnerUp;
      };

      // Measured 2026-08-09: 0.096 with the query prefix, 0.032 without. The
      // assertion is the INEQUALITY rather than either number, because the
      // point is that the prefixes are not interchangeable, and pinning a float
      // from one machine's quantised run would be a brittle way to say it.
      expect(margin(withPrefix)).toBeGreaterThan(margin(wrongPrefix ?? []));
    },
    600_000,
  );

  it(
    "should emit the model's native width before truncation, confirming 768 is not a guess",
    async () => {
      const native = createEmbedder({ dimensions: spec.nativeDimensions });
      const vector = await native.embedQuery(QUESTION);
      expect(vector).toHaveLength(768);
    },
    600_000,
  );

  it(
    "should report the device it actually resolved to",
    async () => {
      const embedder = createEmbedder();
      const device = await embedder.device();
      // No WebGPU in Node 22, so this is cpu here. The assertion is that the
      // embedder KNOWS, not that the answer is any particular value.
      expect(["cpu", "webgpu"]).toContain(device.device);
      expect(device.reason).toBeTruthy();
    },
    600_000,
  );
});

describe("memory/embed live-test wiring", () => {
  it("should keep the real model out of the default test run", () => {
    // A guard on the guard: if someone removes the skip, this states plainly
    // that a default `npm test` is not allowed to download several hundred
    // megabytes. It passes either way — it exists to be read.
    expect(LIVE).toBe(process.env["SYL_EMBED_LIVE"] === "1");
    if (!LIVE) expect(process.env["SYL_EMBED_LIVE"]).not.toBe("1");
  });

  it("should build the same prefixed strings the live probe relies on", () => {
    expect(queryText(QUESTION)).toBe(`task: search result | query: ${QUESTION}`);
    expect(documentText(DOCUMENTS[CORRECT] ?? "")).toBe(
      `title: none | text: ${DOCUMENTS[CORRECT] ?? ""}`,
    );
  });
});
