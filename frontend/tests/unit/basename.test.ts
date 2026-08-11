import { describe, expect, it } from "vitest";

import { resolveBasename } from "../../src/app/basename";

/**
 * The router's basename, derived from the base the bundle was built with.
 *
 * Syl serves this bundle at `/admin`, so every path React Router matches is one
 * segment deeper than the path it was written as. Getting this wrong does not
 * fail loudly: the page loads, and every route renders the not-found view.
 *
 * It is a pure function of `import.meta.env.BASE_URL` so the value can be
 * tested without a build, and so the dev server, the built bundle and the test
 * environment all get their answer from the same rule.
 */
describe("resolveBasename", () => {
  it("should strip the trailing slash Vite's BASE_URL always carries", () => {
    expect(resolveBasename("/admin/")).toBe("/admin");
  });

  it("should accept a base that already has no trailing slash", () => {
    expect(resolveBasename("/admin")).toBe("/admin");
  });

  it("should return the root for the root base, which is what a test run sees", () => {
    expect(resolveBasename("/")).toBe("/");
  });

  it("should return the root when nothing was configured", () => {
    expect(resolveBasename(undefined)).toBe("/");
    expect(resolveBasename("")).toBe("/");
    expect(resolveBasename("   ")).toBe("/");
  });

  it("should keep a nested base intact", () => {
    expect(resolveBasename("/tools/admin/")).toBe("/tools/admin");
  });
});
