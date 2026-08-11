import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PagingError,
  decodeOffsetCursor,
  encodeOffsetCursor,
  pageOf,
  resolvePageLimit,
} from "../../src/services/paging.js";

describe("paging", () => {
  describe("cursors", () => {
    it("should round-trip an offset", () => {
      expect(decodeOffsetCursor(encodeOffsetCursor(0))).toBe(0);
      expect(decodeOffsetCursor(encodeOffsetCursor(137))).toBe(137);
    });

    it("should be opaque rather than a bare number", () => {
      expect(encodeOffsetCursor(137)).not.toBe("137");
    });

    it("should refuse a cursor it did not issue", () => {
      // A cursor that cannot be read must be refused rather than silently
      // treated as "start from the beginning", which makes a paginating client
      // loop forever over the first page.
      expect(() => decodeOffsetCursor("not-a-cursor")).toThrow(PagingError);
      expect(() => decodeOffsetCursor(Buffer.from("{}").toString("base64"))).toThrow(PagingError);
      expect(() =>
        decodeOffsetCursor(Buffer.from(JSON.stringify({ offset: -1 })).toString("base64")),
      ).toThrow(PagingError);
      expect(() =>
        decodeOffsetCursor(Buffer.from(JSON.stringify({ offset: 1.5 })).toString("base64")),
      ).toThrow(PagingError);
    });

    it("should report a bad cursor as a bad cursor", () => {
      try {
        decodeOffsetCursor("nope");
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(PagingError);
        expect((error as PagingError).kind).toBe("bad_cursor");
      }
    });
  });

  describe("resolvePageLimit", () => {
    it("should default when nothing was asked for", () => {
      expect(resolvePageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    });

    it("should accept a limit inside the range", () => {
      expect(resolvePageLimit(1)).toBe(1);
      expect(resolvePageLimit(MAX_PAGE_LIMIT)).toBe(MAX_PAGE_LIMIT);
    });

    it("should refuse a limit outside the range or not a whole number", () => {
      expect(() => resolvePageLimit(0)).toThrow(PagingError);
      expect(() => resolvePageLimit(MAX_PAGE_LIMIT + 1)).toThrow(PagingError);
      expect(() => resolvePageLimit(2.5)).toThrow(PagingError);
    });
  });

  describe("pageOf", () => {
    it("should hand back a full page and a cursor when there is more", () => {
      // The caller reads limit + 1 rows; the extra row is how "is there more"
      // is answered without a second COUNT query.
      const page = pageOf(["a", "b", "c"], 2, 0);
      expect(page.items).toEqual(["a", "b"]);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();
      expect(decodeOffsetCursor(page.nextCursor ?? "")).toBe(2);
    });

    it("should end the walk with a null cursor", () => {
      const page = pageOf(["a"], 2, 0);
      expect(page.items).toEqual(["a"]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it("should carry the starting offset into the next cursor", () => {
      const page = pageOf(["c", "d", "e"], 2, 10);
      expect(decodeOffsetCursor(page.nextCursor ?? "")).toBe(12);
    });

    it("should handle an empty result", () => {
      const page = pageOf([], 2, 0);
      expect(page.items).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });
});
