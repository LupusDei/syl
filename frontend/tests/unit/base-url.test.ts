import { describe, expect, it } from "vitest";

import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from "../../src/api/base-url";

describe("resolveApiBaseUrl", () => {
  it("should fall back to the dev-proxy path when nothing is configured", () => {
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_API_BASE_URL);
  });

  it("should use VITE_API_BASE_URL when it is set", () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: "http://localhost:4201" })).toBe(
      "http://localhost:4201",
    );
  });

  it("should strip trailing slashes so path joining never doubles them", () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: "http://localhost:4201///" })).toBe(
      "http://localhost:4201",
    );
  });

  it("should fall back when the configured value is blank", () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: "   " })).toBe(DEFAULT_API_BASE_URL);
  });

  it("should fall back when the configured value is only slashes", () => {
    expect(resolveApiBaseUrl({ VITE_API_BASE_URL: "/" })).toBe(DEFAULT_API_BASE_URL);
  });
});
