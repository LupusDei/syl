import { describe, expect, it } from "vitest";

import {
  UnreadableDocument,
  chunkDocument,
  parseDocument,
  sniffMediaType,
} from "../../src/connections/document.js";

/**
 * Turning a fetched response into text and chunks.
 *
 * No model runs anywhere in this file, and that is the point: everything here
 * happens before the untrusted text is shown to anything that could act on it.
 * The failures this layer can have are ordinary parsing failures.
 */

describe("sniffMediaType", () => {
  it("should call a document HTML when the body opens with markup", () => {
    expect(sniffMediaType("<!DOCTYPE html><html><body>hi</body></html>", undefined)).toBe(
      "text/html",
    );
  });

  it("should call a document plain text when there is no markup", () => {
    expect(sniffMediaType("Just a paragraph of prose.", undefined)).toBe("text/plain");
  });

  it("should trust the sniff over a declared type that disagrees", () => {
    // The proposal is explicit: the declared type is not trusted over the
    // sniffed one. A server that labels markup as text/plain does not get to
    // decide that a `<script>` block reaches the extractor untouched.
    expect(sniffMediaType("<html><body><p>hi</p></body></html>", "text/plain")).toBe("text/html");
  });

  it("should fall back to the declared type when the body is ambiguous", () => {
    expect(sniffMediaType("plain words", "text/html; charset=utf-8")).toBe("text/html");
  });
});

describe("parseDocument", () => {
  const PAGE = [
    "<!DOCTYPE html>",
    "<html><head><title>Tidy Desks, Tidy Minds</title>",
    "<style>body { color: red }</style>",
    "<script>window.tracker = 1</script>",
    "</head><body>",
    "<p>A study of remote workers found fewer context switches.</p>",
    "<!-- an editorial note -->",
    "<p>A second paragraph &amp; an entity.</p>",
    "</body></html>",
  ].join("\n");

  it("should return the title and the readable text", () => {
    const parsed = parseDocument(PAGE);

    expect(parsed.title).toBe("Tidy Desks, Tidy Minds");
    expect(parsed.text).toContain("A study of remote workers found fewer context switches.");
    expect(parsed.text).toContain("A second paragraph & an entity.");
    expect(parsed.mediaType).toBe("text/html");
  });

  it("should drop script, style and comment content entirely", () => {
    const parsed = parseDocument(PAGE);

    expect(parsed.text).not.toContain("window.tracker");
    expect(parsed.text).not.toContain("color: red");
    expect(parsed.text).not.toContain("editorial note");
  });

  it("should keep paragraphs apart so chunking has boundaries to use", () => {
    const parsed = parseDocument(PAGE);

    expect(parsed.text.split(/\n{2,}/)).toHaveLength(2);
  });

  it("should pass plain text through with no title", () => {
    const parsed = parseDocument("One paragraph.\n\nAnother paragraph.");

    expect(parsed.title).toBeNull();
    expect(parsed.mediaType).toBe("text/plain");
    expect(parsed.text).toBe("One paragraph.\n\nAnother paragraph.");
  });

  it("should refuse a body that is not text at all", () => {
    // A NUL byte means we fetched an image, an archive, or a font. Handing
    // that to a turn spends money to read mojibake.
    const error = catching(() => parseDocument("PK\u0000\u0000binary"));

    expect(error).toBeInstanceOf(UnreadableDocument);
    expect((error as UnreadableDocument).reason).toBe("binary");
  });

  it("should refuse a document with no readable text left after stripping", () => {
    const error = catching(() => parseDocument("<html><head><script>x=1</script></head></html>"));

    expect(error).toBeInstanceOf(UnreadableDocument);
    expect((error as UnreadableDocument).reason).toBe("empty");
  });
});

describe("chunkDocument", () => {
  it("should return one chunk covering the whole text when it is short", () => {
    const chunks = chunkDocument("A short article.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, start: 0, end: 16, text: "A short article." });
  });

  it("should split on paragraph boundaries and record offsets into the source text", () => {
    // The offsets are provenance: "chapter eleven, characters 400 to 900" is
    // what makes a claim traceable back to the words that produced it.
    const text = ["a".repeat(60), "b".repeat(60), "c".repeat(60)].join("\n\n");

    const chunks = chunkDocument(text, { maxChars: 130 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
  });

  it("should cover the text without gaps or overlap", () => {
    const text = Array.from({ length: 12 }, (_, i) => `paragraph ${i} `.repeat(6)).join("\n\n");

    const chunks = chunkDocument(text, { maxChars: 200 });

    let previousEnd = 0;
    for (const chunk of chunks) {
      expect(chunk.start).toBeGreaterThanOrEqual(previousEnd);
      expect(chunk.end).toBeGreaterThan(chunk.start);
      previousEnd = chunk.end;
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toHaveLength(
      chunks.reduce((total, chunk) => total + chunk.text.length, 0),
    );
  });

  it("should hard-split a single paragraph longer than the budget", () => {
    // A wall of text with no blank line in it still has to fit in a turn.
    const text = "x".repeat(500);

    const chunks = chunkDocument(text, { maxChars: 120 });

    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(120);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  });

  it("should return nothing for text with no content", () => {
    expect(chunkDocument("   \n\n  ")).toEqual([]);
  });

  it("should refuse a budget that could not hold a sentence", () => {
    expect(() => chunkDocument("hello", { maxChars: 0 })).toThrow(/maxChars/);
  });
});

/** Run a function and hand back whatever it threw. */
function catching(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
