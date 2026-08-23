import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AUTO_INDEX_BEGIN,
  AUTO_INDEX_END,
  AUTO_INDEX_HEADING,
  MemoryIndexOverflowError,
  buildMemoryIndex,
  isReferencedIn,
  rebuildMemoryIndex,
  summariseMemoryFile,
  withMemoryIndex,
  type MemoryTopic,
} from "../../src/memory/index-guarantee.js";
import {
  AUTO_MEMORY_INDEX,
  AUTO_MEMORY_INDEX_MAX_BYTES,
  AUTO_MEMORY_INDEX_MAX_LINES,
  autoMemoryAt,
  autoMemoryOff,
} from "../../src/memory/auto-memory.js";
import type { TurnOptions, TurnResult } from "../../src/harness/session.js";

/**
 * Real captured data, not shapes invented from our own types.
 *
 * - `memory-topic-canary.md` is the file Claude Code 2.1.226 wrote for
 *   `syl-03d` — the haiku turn that remembered the canary and then did not
 *   index it. Frontmatter and all, byte for byte.
 * - `memory-index-real.md` is a `MEMORY.md` a model actually maintained by
 *   hand, taken from `~/.claude/projects/-Users-Reason-code-ai-adjutant/memory/`.
 *   It matters because it is *messy* in ways nobody would invent: some entries
 *   are `- [file.md](file.md) — summary`, some are prose bullets with no file
 *   at all, one puts a phrase in the link text instead of the filename, and one
 *   paragraph names four topic files in backticks rather than as links. And two
 *   files in that directory are missing from it entirely — the same bug, in the
 *   wild, months old.
 */
const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const REAL_TOPIC = readFileSync(join(FIXTURES, "memory-topic-canary.md"), "utf8");
const REAL_INDEX = readFileSync(join(FIXTURES, "memory-index-real.md"), "utf8");

/** Files present in that real directory but absent from its real `MEMORY.md`. */
const REAL_ORPHANS = [
  "feedback_answer_via_adjutant.md",
  "worktree-npx-corrupts-main-node-modules.md",
] as const;

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** A real directory in a temp location. Cheaper and truer than stubbing `fs`. */
function memoryDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "syl-memidx-"));
  temps.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return dir;
}

function indexPath(dir: string): string {
  return join(dir, AUTO_MEMORY_INDEX);
}

function readIndex(dir: string): string {
  return readFileSync(indexPath(dir), "utf8");
}

/** Push a file's mtime back so "newest first" has something to sort on. */
function ageBy(dir: string, file: string, seconds: number): void {
  const when = new Date(Date.now() - seconds * 1000);
  utimesSync(join(dir, file), when, when);
}

function topic(file: string, summary: string | undefined, modifiedMs: number): MemoryTopic {
  return { file, summary, modifiedMs };
}

/** The lines of the generated block, markers excluded. */
function blockOf(text: string): string[] {
  const begin = text.indexOf(AUTO_INDEX_BEGIN);
  const end = text.indexOf(AUTO_INDEX_END);
  if (begin < 0 || end < 0) return [];
  return text.slice(begin, end + AUTO_INDEX_END.length).split("\n");
}

function turnResult(sessionId = "s-1"): TurnResult {
  return {
    sessionId,
    text: "ok",
    // No tool call in a double, so the two are the same string.
    spoken: "ok",
    costUsd: 0,
    numTurns: 1,
    contextTokens: 0,
    init: { kind: "init", sessionId, tools: [], apiKeySource: "none" },
    events: [],
  } as unknown as TurnResult;
}

describe("summariseMemoryFile", () => {
  it("should use the frontmatter description when the CLI wrote one", () => {
    expect(summariseMemoryFile(REAL_TOPIC)).toBe(
      "Syl production canary identifier for monitoring and alerts",
    );
  });

  it("should fall back to the first heading when there is no frontmatter", () => {
    expect(summariseMemoryFile("# Dolt port pinning\n\nSome body text.\n")).toBe(
      "Dolt port pinning",
    );
  });

  it("should fall back to the first prose line when there is no heading either", () => {
    expect(summariseMemoryFile("\n\n- the port file is authoritative, not metadata\n")).toBe(
      "the port file is authoritative, not metadata",
    );
  });

  it("should return undefined for a file with nothing in it", () => {
    expect(summariseMemoryFile("")).toBeUndefined();
    expect(summariseMemoryFile("---\nname: x\n---\n")).toBe("x");
  });

  it("should collapse a multi-line summary to one line and cap its length", () => {
    const long = `word `.repeat(200).trim();
    const summary = summariseMemoryFile(`---\ndescription: ${long}\n---\n`);
    expect(summary).toBeDefined();
    expect(summary).not.toContain("\n");
    expect((summary as string).length).toBeLessThanOrEqual(201);
    expect(summary).toMatch(/…$/);
  });

  it("should ignore nested frontmatter keys rather than mistaking one for a description", () => {
    // The real capture nests `node_type`, `type`, `originSessionId` under
    // `metadata:`. A naive `key: value` scan picks up `type: reference`.
    expect(summariseMemoryFile(REAL_TOPIC)).not.toContain("reference");
  });
});

describe("isReferencedIn", () => {
  it("should see a plain markdown link", () => {
    expect(isReferencedIn(REAL_INDEX, "ios_livekit_toolchain_network_hang.md")).toBe(true);
  });

  it("should see a filename the model only mentioned in prose", () => {
    // Line 46 of the real index names four topic files in backticks. They are
    // reachable — the model can read what it can see — so Syl must not add a
    // second entry for them.
    expect(isReferencedIn(REAL_INDEX, "feedback_always_use_mcp_messages.md")).toBe(true);
  });

  it("should see a link whose text is a phrase rather than the filename", () => {
    expect(isReferencedIn(REAL_INDEX, "squad_worktree_checkout_leak.md")).toBe(true);
  });

  it("should not count a filename that is merely a suffix of another", () => {
    expect(isReferencedIn("- [my_notes.md](my_notes.md)\n", "notes.md")).toBe(false);
    expect(isReferencedIn("- see notes.md.bak\n", "notes.md")).toBe(false);
  });

  it("should report the files the real index genuinely left out", () => {
    for (const orphan of REAL_ORPHANS) expect(isReferencedIn(REAL_INDEX, orphan)).toBe(false);
  });
});

describe("buildMemoryIndex", () => {
  it("should index a topic file the model never mentioned", () => {
    const plan = buildMemoryIndex("# Memory\n\n## Notes\n- something\n", [
      topic("syl_production_canary.md", "Syl production canary identifier", 1),
    ]);

    expect(plan.changed).toBe(true);
    expect(plan.indexed).toEqual(["syl_production_canary.md"]);
    expect(plan.text).toContain(
      "- [syl_production_canary.md](syl_production_canary.md) — Syl production canary identifier",
    );
  });

  it("should put the block directly under the title, inside the loaded window", () => {
    // Not at the end of the file: only the first 200 lines / 25 KB are loaded,
    // so an entry appended after a long hand-written index is exactly as
    // unreachable as no entry at all.
    const plan = buildMemoryIndex(REAL_INDEX, [topic(REAL_ORPHANS[0], "how to answer", 1)]);
    const lines = plan.text.split("\n");

    expect(lines[0]).toBe("# Adjutant Project Memory");
    expect(lines.findIndex((l) => l.startsWith(AUTO_INDEX_BEGIN))).toBeLessThan(4);
  });

  it("should leave every file the model already indexed alone", () => {
    const topics = [
      topic("ios_livekit_toolchain_network_hang.md", "sim builds hang", 3),
      topic("feedback_always_use_mcp_messages.md", "use mcp", 2),
      topic(REAL_ORPHANS[1], "npx corrupts node_modules", 1),
    ];
    const plan = buildMemoryIndex(REAL_INDEX, topics);

    expect(plan.indexed).toEqual([REAL_ORPHANS[1]]);
    expect(plan.referenced).toEqual([
      "ios_livekit_toolchain_network_hang.md",
      "feedback_always_use_mcp_messages.md",
    ]);
    // Every line the model wrote survives, byte for byte.
    for (const line of REAL_INDEX.split("\n")) {
      if (line.trim() !== "") expect(plan.text).toContain(line);
    }
  });

  it("should keep a line the model rewrote inside the block rather than regenerate it", () => {
    const first = buildMemoryIndex("# Memory\n", [topic("canary.md", "generated summary", 1)]);
    const edited = first.text.replace(
      "— generated summary",
      "— the production canary, ORION-3312, checked every morning",
    );

    const second = buildMemoryIndex(edited, [topic("canary.md", "generated summary", 1)]);

    expect(second.text).toContain("the production canary, ORION-3312, checked every morning");
    expect(second.text).not.toContain("— generated summary");
    expect(second.changed).toBe(false);
  });

  it("should stop regenerating an entry the model promoted into its own section", () => {
    const first = buildMemoryIndex("# Memory\n", [topic("canary.md", "generated summary", 1)]);
    const promoted = `# Memory\n\n## Operations\n- [canary.md](canary.md) — the canary\n`;

    const second = buildMemoryIndex(promoted, [topic("canary.md", "generated summary", 1)]);

    expect(first.text).toContain(AUTO_INDEX_BEGIN);
    expect(second.text).not.toContain(AUTO_INDEX_BEGIN);
    expect(second.indexed).toEqual([]);
    expect(second.referenced).toEqual(["canary.md"]);
  });

  it("should drop an entry whose topic file has been deleted", () => {
    const first = buildMemoryIndex("# Memory\n", [
      topic("gone.md", "was here", 2),
      topic("stays.md", "still here", 1),
    ]);
    const second = buildMemoryIndex(first.text, [topic("stays.md", "still here", 1)]);

    expect(second.text).not.toContain("gone.md");
    expect(second.text).toContain("stays.md");
  });

  it("should be idempotent — a second pass changes nothing", () => {
    const first = buildMemoryIndex(REAL_INDEX, REAL_ORPHANS.map((f, i) => topic(f, `s${i}`, i)));
    const second = buildMemoryIndex(first.text, REAL_ORPHANS.map((f, i) => topic(f, `s${i}`, i)));

    expect(second.text).toBe(first.text);
    expect(second.changed).toBe(false);
  });

  it("should insert at the top when the index has no title at all", () => {
    const plan = buildMemoryIndex("", [topic("canary.md", "the canary", 1)]);
    expect(plan.text.startsWith("# ")).toBe(true);
    expect(plan.text).toContain(AUTO_INDEX_HEADING);
  });

  it("should keep the newest memories and say out loud which ones did not fit", () => {
    const topics = Array.from({ length: 12 }, (_, i) =>
      topic(`m${String(i).padStart(2, "0")}.md`, `summary ${i}`, i),
    );
    // 10 lines: two markers, a heading, two blanks, four entries and the notice.
    const plan = buildMemoryIndex("# Memory\n", topics, { maxLines: 10 });

    // Newest first: m11 is the most recently modified.
    expect(plan.indexed).toEqual(["m11.md", "m10.md", "m09.md", "m08.md"]);
    expect(plan.dropped).toHaveLength(8);
    expect(plan.dropped[0]).toBe("m07.md");
    // Dropped from the index, but never dropped silently.
    expect(plan.text).toContain("8 older memories");
    expect(plan.text).not.toContain("m00.md");
  });

  it("should respect a byte budget as well as a line budget", () => {
    const topics = Array.from({ length: 12 }, (_, i) => topic(`m${i}.md`, "x".repeat(300), i));
    const plan = buildMemoryIndex("# Memory\n", topics, { maxBytes: 1_200 });

    const block = blockOf(plan.text).join("\n");
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(1_200);
    expect(plan.dropped.length).toBeGreaterThan(0);
  });

  it("should keep the whole block inside the window the CLI actually loads", () => {
    const topics = Array.from({ length: 400 }, (_, i) => topic(`m${i}.md`, "y".repeat(120), i));
    const plan = buildMemoryIndex("# Memory\n", topics);

    const lines = plan.text.split("\n");
    const end = lines.findIndex((l) => l.startsWith(AUTO_INDEX_END));
    expect(end).toBeGreaterThan(0);
    expect(end).toBeLessThan(AUTO_MEMORY_INDEX_MAX_LINES);
    const loaded = lines.slice(0, end + 1).join("\n");
    expect(Buffer.byteLength(loaded, "utf8")).toBeLessThan(AUTO_MEMORY_INDEX_MAX_BYTES);
  });

  it("should render an entry with no summary as a bare link", () => {
    const plan = buildMemoryIndex("# Memory\n", [topic("bare.md", undefined, 1)]);
    expect(plan.text).toContain("- [bare.md](bare.md)\n");
  });
});

describe("rebuildMemoryIndex", () => {
  it("should make a memory written without an index entry reachable again", () => {
    // The regression for syl-03d, in the shape it was captured: a haiku turn
    // wrote the topic file and no index, and the next session answered NONE.
    const dir = memoryDir({ "syl_production_canary.md": REAL_TOPIC });

    const result = rebuildMemoryIndex(dir);

    expect(result.changed).toBe(true);
    expect(result.indexed).toEqual(["syl_production_canary.md"]);
    expect(readIndex(dir)).toContain(
      "- [syl_production_canary.md](syl_production_canary.md) — " +
        "Syl production canary identifier for monitoring and alerts",
    );
  });

  it("should add only the entries a real hand-maintained index is missing", () => {
    const dir = memoryDir({
      [AUTO_MEMORY_INDEX]: REAL_INDEX,
      "ios_livekit_toolchain_network_hang.md": "# LiveKit toolchain hang\n",
      [REAL_ORPHANS[0]]: "# Answer via Adjutant\n",
      [REAL_ORPHANS[1]]: "# npx corrupts main node_modules\n",
    });

    const result = rebuildMemoryIndex(dir);

    expect(result.indexed.slice().sort()).toEqual([...REAL_ORPHANS].sort());
    expect(result.referenced).toEqual(["ios_livekit_toolchain_network_hang.md"]);
    expect(readIndex(dir)).toContain("# Adjutant Project Memory");
  });

  it("should do nothing at all when the directory does not exist", () => {
    const result = rebuildMemoryIndex(join(tmpdir(), "syl-memidx-absent-dir"));

    expect(result.changed).toBe(false);
    expect(result.topics).toBe(0);
    expect(result.indexed).toEqual([]);
  });

  it("should not write when nothing is missing", () => {
    const dir = memoryDir({
      [AUTO_MEMORY_INDEX]: "# Memory\n\n- [a.md](a.md) — first\n",
      "a.md": "# First\n",
    });
    const before = readIndex(dir);

    const result = rebuildMemoryIndex(dir);

    expect(result.changed).toBe(false);
    expect(readIndex(dir)).toBe(before);
  });

  it("should ignore files that are not memories", () => {
    const dir = memoryDir({
      "notes.txt": "not markdown",
      ".hidden.md": "# hidden\n",
      "real.md": "# real\n",
    });

    const result = rebuildMemoryIndex(dir);

    expect(result.topics).toBe(1);
    expect(result.indexed).toEqual(["real.md"]);
  });

  it("should order by modification time, newest first", () => {
    const dir = memoryDir({ "old.md": "# old\n", "new.md": "# new\n" });
    ageBy(dir, "old.md", 3600);

    const result = rebuildMemoryIndex(dir);

    expect(result.indexed).toEqual(["new.md", "old.md"]);
  });

  it("should refuse to write past the size the CLI hard-errors on", () => {
    const dir = memoryDir({
      [AUTO_MEMORY_INDEX]: `# Memory\n\n${"filler line\n".repeat(11_000)}`,
      "canary.md": REAL_TOPIC,
    });

    expect(() => rebuildMemoryIndex(dir)).toThrow(MemoryIndexOverflowError);
  });

  it("should leave no temporary files behind", () => {
    const dir = memoryDir({ "canary.md": REAL_TOPIC });
    rebuildMemoryIndex(dir);
    const result = rebuildMemoryIndex(dir);
    expect(result.changed).toBe(false);
    expect(readIndex(dir)).toContain("canary.md");
  });
});

describe("withMemoryIndex", () => {
  it("should rebuild the index after a turn that had a memory directory", () => {
    const dir = memoryDir({ "syl_production_canary.md": REAL_TOPIC });
    const runner = withMemoryIndex(async () => turnResult());

    return runner("remember the canary", { autoMemory: autoMemoryAt(dir) }).then((result) => {
      expect(result.sessionId).toBe("s-1");
      expect(readIndex(dir)).toContain("syl_production_canary.md");
    });
  });

  it("should rebuild even when the turn threw — the file may already be written", () => {
    const dir = memoryDir({ "syl_production_canary.md": REAL_TOPIC });
    const boom = new Error("turn died");
    const runner = withMemoryIndex(async () => {
      throw boom;
    });

    return runner("x", { autoMemory: autoMemoryAt(dir) }).then(
      () => expect.unreachable("the turn's own failure must still surface"),
      (error) => {
        expect(error).toBe(boom);
        expect(readIndex(dir)).toContain("syl_production_canary.md");
      },
    );
  });

  it("should do nothing when the turn had memory switched off", async () => {
    const seen: string[] = [];
    const runner = withMemoryIndex(async () => turnResult(), {
      rebuild: (directory) => {
        seen.push(directory);
        throw new Error("must not be called");
      },
    });

    await runner("x", { autoMemory: autoMemoryOff() });
    await runner("x", {} as TurnOptions);

    expect(seen).toEqual([]);
  });

  it("should report a rebuild failure without taking the turn's answer down with it", async () => {
    const failure = new Error("disk full");
    const errors: unknown[] = [];
    const runner = withMemoryIndex(async () => turnResult("s-9"), {
      rebuild: () => {
        throw failure;
      },
      onError: (error) => errors.push(error),
    });

    const result = await runner("x", { autoMemory: autoMemoryAt(memoryDir()) });

    expect(result.sessionId).toBe("s-9");
    expect(errors).toEqual([failure]);
  });

  it("should hand each rebuild result to the observer", async () => {
    const dir = memoryDir({ "syl_production_canary.md": REAL_TOPIC });
    const seen: number[] = [];
    const runner = withMemoryIndex(async () => turnResult(), {
      onRebuild: (result) => seen.push(result.indexed.length),
    });

    await runner("x", { autoMemory: autoMemoryAt(dir) });
    await runner("x", { autoMemory: autoMemoryAt(dir) });

    // One entry added on the first pass, nothing to do on the second.
    expect(seen).toEqual([1, 1]);
  });
});
