import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "../../src/app/nav";

describe("NAV_ITEMS", () => {
  it("should expose at least the overview plus the planned viewers", () => {
    expect(NAV_ITEMS.length).toBeGreaterThanOrEqual(4);
  });

  it("should start at the root path, so the default route is the overview", () => {
    expect(NAV_ITEMS[0]?.path).toBe("/");
  });

  it("should use unique paths, or two nav entries would highlight at once", () => {
    const paths = NAV_ITEMS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("should give every entry a label and an absolute path", () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.path.startsWith("/")).toBe(true);
    }
  });

  it("should name the bead that owns each unbuilt view", () => {
    for (const item of NAV_ITEMS) {
      if (item.status === "planned") expect(item.bead).toMatch(/^syl-\d/);
    }
  });
});
