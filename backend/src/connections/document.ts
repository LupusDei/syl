/**
 * A fetched response, turned into text and then into chunks.
 *
 * **No model runs in this file.** That is the whole reason it is a separate
 * step: the HTML parse, the entity decode and the chunking all happen in
 * ordinary service code, before the text is shown to anything that could be
 * persuaded by it. Nothing in a fetched page can instruct anything here,
 * because there is nothing here to instruct.
 *
 * Two decisions are worth stating.
 *
 * **The sniffed type beats the declared one.** A server that labels markup as
 * `text/plain` does not get to decide that its `<script>` bodies reach the
 * extractor as prose.
 *
 * **Chunks carry offsets into the parsed text, and they tile it in order.**
 * The offsets are provenance: "this claim came from characters 4,200 to 5,100
 * of source X" is what makes a surprising statement traceable a year later,
 * and what a hard delete follows. Overlapping or out-of-order chunks would
 * make that a lie, so the tests assert the tiling rather than a chunk count.
 */

/** What the extractor is willing to read. */
export type ReadableMediaType = "text/html" | "text/plain";

/** A parsed document: what a reader turn will eventually see. */
export interface ParsedDocument {
  /** The `<title>`, if the document had one. */
  readonly title: string | null;
  /** Readable text, paragraphs separated by a blank line. */
  readonly text: string;
  readonly mediaType: ReadableMediaType;
}

/** One unit of work for a reader turn. */
export interface DocumentChunk {
  /** Position in the ladder, from zero. */
  readonly index: number;
  /** Inclusive start offset into {@link ParsedDocument.text}. */
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
  readonly text: string;
}

/** The body was fetched, but there is nothing readable in it. */
export class UnreadableDocument extends Error {
  readonly reason: "binary" | "empty";

  constructor(reason: UnreadableDocument["reason"], message: string) {
    super(message);
    this.name = "UnreadableDocument";
    this.reason = reason;
  }
}

/**
 * How much text one reader turn gets.
 *
 * A chapter is the natural unit for a book and a whole article is the natural
 * unit for a post; both are well under this. This is the ceiling that stops a
 * single badly-formed page from becoming one enormous turn.
 */
export const DEFAULT_CHUNK_CHARS = 12_000;

/** The byte that means "this is not text". */
const NUL = "\u0000";

/**
 * Elements whose contents are never prose.
 *
 * `title` is in here because it is read out separately, before any stripping;
 * leaving it would put the title in the body text as well.
 */
const NON_CONTENT = /<(script|style|noscript|template|svg|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Elements that end a paragraph. */
const BLOCK_LEVEL =
  /<\/?(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|ul|ol|tr|table|blockquote|pre|br|hr|figure|figcaption)\b[^>]*>/gi;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const ANY_TAG = /<[^>]*>/g;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

/** The entities that actually appear in prose. Numeric forms are handled too. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const codePoint = hex
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // A malformed or out-of-range reference is left as written rather than
      // becoming U+FFFD: the raw text is more useful to whoever reads the log.
      if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff) return match;
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Decide what a body is, trusting what it looks like over what it claims.
 *
 * The declared type is consulted only when the body itself is ambiguous.
 */
export function sniffMediaType(body: string, declared: string | undefined): ReadableMediaType {
  const head = body.slice(0, 2048).trimStart().toLowerCase();
  if (/^<!doctype html/.test(head) || /<\/?(html|body|head|p|div|article)\b/.test(head)) {
    return "text/html";
  }
  return declared !== undefined && declared.toLowerCase().includes("html")
    ? "text/html"
    : "text/plain";
}

/**
 * Parse a fetched body into readable text.
 *
 * @throws {UnreadableDocument} if the body is binary, or if nothing readable
 * survives stripping.
 */
export function parseDocument(body: string, declaredType?: string): ParsedDocument {
  // A NUL byte means an image, an archive or a font. Handing that to a turn
  // spends real money reading mojibake, and the model will dutifully try.
  if (body.includes(NUL)) {
    throw new UnreadableDocument("binary", "That response is not text; Syl will not read it.");
  }

  const mediaType = sniffMediaType(body, declaredType);

  if (mediaType === "text/plain") {
    const plain = normalise(body);
    if (plain === "") {
      throw new UnreadableDocument("empty", "That response had no readable text in it.");
    }
    return { title: null, text: plain, mediaType };
  }

  const rawTitle = TITLE.exec(body)?.[1];
  const title =
    rawTitle === undefined ? null : collapse(decodeEntities(rawTitle.replace(ANY_TAG, " ")));

  const stripped = body
    .replace(NON_CONTENT, " ")
    .replace(HTML_COMMENT, " ")
    // Block boundaries become blank lines BEFORE the remaining tags go, or
    // every paragraph runs into the next and chunking has nothing to split on.
    .replace(BLOCK_LEVEL, "\n\n")
    .replace(ANY_TAG, " ");

  const text = normalise(decodeEntities(stripped));
  if (text === "") {
    throw new UnreadableDocument("empty", "That response had no readable text in it.");
  }

  return { title: title === null || title === "" ? null : title, text, mediaType };
}

/** Collapse runs of horizontal whitespace. */
function collapse(text: string): string {
  return text.replace(/[^\S\n]+/g, " ").trim();
}

/** Trim each line, drop empties, and separate paragraphs by one blank line. */
function normalise(text: string): string {
  return text
    .split("\n")
    .map((line) => collapse(line))
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .split("\n\n")
    .map((paragraph) => paragraph.split("\n").join(" ").trim())
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
}

export interface ChunkOptions {
  /** Defaults to {@link DEFAULT_CHUNK_CHARS}. */
  readonly maxChars?: number;
}

/**
 * Split text into chunks, preferring paragraph breaks.
 *
 * A paragraph that would fit in a chunk of its own but not in what is left of
 * the current one starts a new chunk. A paragraph longer than the budget is
 * hard-split: a wall of text with no blank line in it still has to fit in a
 * turn.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): readonly DocumentChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_CHUNK_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(`chunkDocument: maxChars must be a positive whole number, got ${maxChars}.`);
  }

  const paragraphs = splitParagraphs(text);
  const chunks: DocumentChunk[] = [];

  let start = -1;
  let end = -1;

  const flush = (): void => {
    if (start === -1) return;
    chunks.push({ index: chunks.length, start, end, text: text.slice(start, end) });
    start = -1;
    end = -1;
  };

  for (const paragraph of paragraphs) {
    const length = paragraph.end - paragraph.start;
    if (start !== -1 && length <= maxChars && paragraph.end - start > maxChars) flush();

    let cursor = paragraph.start;
    while (cursor < paragraph.end) {
      if (start === -1) start = cursor;

      const room = maxChars - (cursor - start);
      if (room <= 0) {
        flush();
        continue;
      }

      const take = Math.min(paragraph.end - cursor, room);
      end = cursor + take;
      cursor += take;

      // The paragraph did not fit: end this chunk here rather than gluing the
      // next paragraph onto a fragment of this one.
      if (cursor < paragraph.end) flush();
    }
  }

  flush();
  return chunks;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Offsets of each non-blank paragraph, in order. */
function splitParagraphs(text: string): readonly Span[] {
  const spans: Span[] = [];
  const pattern = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const start = match.index + leading;
    const end = match.index + raw.length - trailing;
    if (end > start) spans.push({ start, end });
  }

  return spans;
}
