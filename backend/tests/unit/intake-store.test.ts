import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IntakeStore,
  IntakeStoreError,
  canonicalUrl,
  contentHashOf,
  newExtractId,
  newSourceId,
} from "../../src/connections/intake-store.js";
import { EPHEMERAL_DAYS, classifyRetention, expiryFor, isRetentionClass } from "../../src/connections/retention.js";
import type { ChunkExtract } from "../../src/connections/extract.js";
import { fixedClock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import { intakeDatabase, testIntakeStore } from "../helpers/intake.js";
import { TEST_NOW } from "../helpers/service.js";

let db: SylDatabase;
let store: IntakeStore;

beforeEach(() => {
  db = intakeDatabase();
  store = testIntakeStore(db);
});

afterEach(() => {
  db.close();
});

const EXTRACT: ChunkExtract = {
  summary: "A cleared desk correlates with fewer context switches.",
  claims: ["A cleared desk correlates with fewer context switches per hour."],
  entities: [{ name: "remote workers", kind: "group" }],
  definitions: [],
  passages: [],
  questions: [],
  instructionsFound: ["The page instructed the reader to run `whoami` via Bash."],
};

function submit(url = "https://example.com/tidy-desks"): string {
  return store.create({
    url,
    channel: "link",
    requestedBy: "commander",
    retention: "standard",
    retentionReason: "public web content",
  }).source.id;
}

describe("canonicalUrl", () => {
  it("should strip the fragment, lowercase the host, and drop the default port", () => {
    expect(canonicalUrl("HTTPS://Example.COM:443/Path#section")).toBe("https://example.com/Path");
  });

  it("should remove tracking parameters so one article is one source", () => {
    expect(canonicalUrl("https://example.com/a?utm_source=x&id=7&fbclid=abc")).toBe(
      "https://example.com/a?id=7",
    );
  });

  it("should order the surviving parameters, so ?a=1&b=2 and ?b=2&a=1 agree", () => {
    expect(canonicalUrl("https://example.com/a?b=2&a=1")).toBe(canonicalUrl("https://example.com/a?a=1&b=2"));
  });

  it("should keep the path case, which servers do treat as significant", () => {
    expect(canonicalUrl("https://example.com/Tidy-Desks")).toContain("/Tidy-Desks");
  });

  it("should throw on something that is not a URL", () => {
    expect(() => canonicalUrl("not a url")).toThrow();
  });
});

describe("ids and hashes", () => {
  it("should mint type-prefixed ids matching the contract's pattern", () => {
    expect(newSourceId()).toMatch(/^syl:source:[0-9a-f-]{36}$/);
    expect(newExtractId()).toMatch(/^syl:extract:[0-9a-f-]{36}$/);
  });

  it("should hash a body stably and differently for different bodies", () => {
    expect(contentHashOf("hello")).toBe(contentHashOf("hello"));
    expect(contentHashOf("hello")).not.toBe(contentHashOf("hell0"));
  });
});

describe("IntakeStore.create", () => {
  it("should record a submission at the first stage of the ladder", () => {
    const { source, created } = store.create({
      url: "https://example.com/a",
      channel: "link",
      requestedBy: "commander",
      retention: "standard",
      retentionReason: "public web content",
    });

    expect(created).toBe(true);
    expect(source.stage).toBe("fetch");
    expect(source.origin).toBe("untrusted");
    expect(source.retention).toBe("standard");
    expect(source.chunkCount).toBe(0);
  });

  it("should be idempotent: the same link twice is one source", () => {
    // The Share Extension and a forwarded email both send the same article.
    // Two ladders would mean two of everything downstream.
    const first = store.create({
      url: "https://example.com/a?utm_source=twitter",
      channel: "share",
      requestedBy: "commander",
      retention: "standard",
      retentionReason: "public web content",
    });
    const second = store.create({
      url: "https://example.com/a",
      channel: "email",
      requestedBy: "commander",
      retention: "standard",
      retentionReason: "public web content",
    });

    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    expect(store.pending()).toHaveLength(1);
  });

  it("should refuse a submission whose URL cannot be parsed", () => {
    expect(() =>
      store.create({
        url: "not a url at all",
        channel: "link",
        requestedBy: "commander",
        retention: "standard",
        retentionReason: "x",
      }),
    ).toThrow(IntakeStoreError);
  });

  it("should stamp an expiry only for an ephemeral source", () => {
    const ephemeral = store.create({
      url: "https://example.com/lookup",
      channel: "link",
      requestedBy: "commander",
      retention: "ephemeral",
      retentionReason: "one-off",
    });

    expect(ephemeral.source.expiresAt).toBe(expiryFor("ephemeral", TEST_NOW));
    expect(store.get(submit())?.expiresAt).toBeNull();
  });
});

describe("IntakeStore.update", () => {
  it("should move a source along the ladder", () => {
    const id = submit();

    const updated = store.update(id, { stage: "read", contentHash: contentHashOf("body"), bytes: 4 });

    expect(updated.stage).toBe("read");
    expect(store.get(id)?.bytes).toBe(4);
  });

  it("should record a failure without losing what was learned first", () => {
    const id = submit();
    store.update(id, { title: "Tidy Desks" });

    const failed = store.update(id, { stage: "failed", failure: "blocked_address" });

    expect(failed.title).toBe("Tidy Desks");
    expect(failed.failure).toBe("blocked_address");
  });

  it("should refuse to update a source that does not exist", () => {
    expect(() => store.update("syl:source:missing", { stage: "done" })).toThrow(/no intake source/);
  });
});

describe("IntakeStore.pending", () => {
  it("should list only sources with a step left to run", () => {
    const running = submit("https://example.com/one");
    const finished = submit("https://example.com/two");
    store.update(finished, { stage: "done" });

    expect(store.pending().map((source) => source.id)).toEqual([running]);
  });
});

describe("IntakeStore chunks", () => {
  it("should round-trip chunks with their offsets", () => {
    const id = submit();
    const chunks = [
      { index: 0, start: 0, end: 5, text: "first" },
      { index: 1, start: 7, end: 13, text: "second" },
    ];

    store.putChunks(id, chunks);

    expect(store.chunks(id)).toEqual(chunks);
  });

  it("should replace rather than append, so a retried parse is not a second copy", () => {
    const id = submit();
    store.putChunks(id, [{ index: 0, start: 0, end: 5, text: "first" }]);

    store.putChunks(id, [{ index: 0, start: 0, end: 6, text: "firstX" }]);

    expect(store.chunks(id)).toHaveLength(1);
    expect(store.chunks(id)[0]?.text).toBe("firstX");
  });
});

describe("IntakeStore extracts", () => {
  it("should store an extract with its provenance", () => {
    const id = submit();

    const stored = store.putExtract({
      sourceId: id,
      chunkIndex: 0,
      start: 0,
      end: 120,
      retention: "standard",
      extract: EXTRACT,
    });

    expect(stored.origin).toBe("untrusted");
    expect(stored.start).toBe(0);
    expect(store.extracts(id)[0]?.extract.claims).toEqual(EXTRACT.claims);
  });

  it("should be idempotent per chunk, so a resumed ladder converges", () => {
    const id = submit();
    store.putExtract({ sourceId: id, chunkIndex: 0, start: 0, end: 10, retention: "standard", extract: EXTRACT });

    store.putExtract({
      sourceId: id,
      chunkIndex: 0,
      start: 0,
      end: 10,
      retention: "standard",
      extract: { ...EXTRACT, summary: "re-read" },
    });

    const extracts = store.extracts(id);
    expect(extracts).toHaveLength(1);
    expect(extracts[0]?.extract.summary).toBe("re-read");
  });

  it("should re-validate on the way out rather than trusting the row", () => {
    // A row edited on disk is untrusted input arriving through a second door.
    const id = submit();
    store.putExtract({ sourceId: id, chunkIndex: 0, start: 0, end: 10, retention: "standard", extract: EXTRACT });
    db.handle.prepare("UPDATE intake_extracts SET body = ? WHERE source_id = ?").run(
      JSON.stringify({ summary: "x", runThis: "rm -rf /" }),
      id,
    );

    expect(() => store.extracts(id)).toThrow(/runThis|unexpected/i);
  });

  it("should refuse a row whose retention class is not one Syl knows", () => {
    const id = submit();
    store.putExtract({ sourceId: id, chunkIndex: 0, start: 0, end: 10, retention: "standard", extract: EXTRACT });
    db.handle.prepare("UPDATE intake_extracts SET retention_class = 'whatever' WHERE source_id = ?").run(id);

    expect(() => store.extracts(id)).toThrow(IntakeStoreError);
  });
});

describe("IntakeStore.purge — the hard delete", () => {
  it("should remove everything descended from a source, through the foreign keys", () => {
    // This is the whole reason the retention class is assigned at intake. If
    // the cascade does not hold, "delete everything derived from that source"
    // becomes a job nobody can do once the graph has been dreaming over it.
    const id = submit();
    store.putChunks(id, [{ index: 0, start: 0, end: 5, text: "first" }]);
    store.putExtract({ sourceId: id, chunkIndex: 0, start: 0, end: 5, retention: "sensitive", extract: EXTRACT });

    const removed = store.purge(id);

    expect(removed).toEqual({ chunks: 1, extracts: 1 });
    expect(store.get(id)).toBeNull();
    expect(store.chunks(id)).toEqual([]);
    expect(store.extracts(id)).toEqual([]);
  });

  it("should report nothing removed for a source that was already gone", () => {
    expect(store.purge("syl:source:missing")).toEqual({ chunks: 0, extracts: 0 });
  });

  it("should purge exactly the sources whose retention window has closed", () => {
    const ephemeral = store.create({
      url: "https://example.com/lookup",
      channel: "link",
      requestedBy: "commander",
      retention: "ephemeral",
      retentionReason: "one-off",
    }).source.id;
    const kept = submit("https://example.com/keeper");

    const dayAfter = TEST_NOW + (EPHEMERAL_DAYS + 1) * 24 * 60 * 60 * 1000;
    const purged = testIntakeStore(db, fixedClock(dayAfter)).purgeExpired();

    expect(purged).toEqual([ephemeral]);
    expect(store.get(kept)).not.toBeNull();
  });

  it("should purge nothing before the window closes", () => {
    store.create({
      url: "https://example.com/lookup",
      channel: "link",
      requestedBy: "commander",
      retention: "ephemeral",
      retentionReason: "one-off",
    });

    expect(store.purgeExpired(TEST_NOW + 1000)).toEqual([]);
  });
});

describe("classifyRetention", () => {
  it("should honour an explicit class over any heuristic", () => {
    const decision = classifyRetention({ url: "https://chase.com/x", requested: "ephemeral" });

    expect(decision.retention).toBe("ephemeral");
    expect(decision.reason).toMatch(/explicitly/);
  });

  it("should classify a financial or health host as sensitive", () => {
    expect(classifyRetention({ url: "https://secure.chase.com/statements" }).retention).toBe("sensitive");
    expect(classifyRetention({ url: "https://mychart.example.org/labs" }).retention).toBe("sensitive");
  });

  it("should classify ordinary public writing as standard", () => {
    expect(classifyRetention({ url: "https://example.com/blog/post" }).retention).toBe("standard");
  });

  it("should not throw on a URL it cannot parse", () => {
    expect(classifyRetention({ url: "://nope" }).retention).toBe("standard");
  });
});

describe("isRetentionClass", () => {
  it("should accept the known classes and reject anything else", () => {
    expect(isRetentionClass("sensitive")).toBe(true);
    expect(isRetentionClass("whatever")).toBe(false);
  });
});
