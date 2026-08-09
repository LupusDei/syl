import { describe, expect, it, vi } from "vitest";

/**
 * The dev proxy must point at SYL's service, not Adjutant's.
 *
 * This is pinned rather than trusted because the two-backends confusion has now
 * cost real time twice: once when an agent read "backend runs on 4201" as Syl's
 * port, and again here, where the proxy shipped pointing at 4201 with a comment
 * citing `.mcp.json` as its authority. `.mcp.json` points at Adjutant because
 * that is where agents send MESSAGES — it says nothing about where Syl serves
 * its API.
 *
 * What makes it worth a test rather than a comment is the failure SHAPE. 4201 is
 * usually listening, so nothing refuses the connection: Adjutant answers every
 * /api call with an Express HTML error page, and the admin gets `<!DOCTYPE html>`
 * where it expected Syl's JSON envelope. The symptom surfaces as a parse error in
 * the client, nowhere near the cause.
 */
describe("the dev proxy target", () => {
  async function loadTarget(env: Record<string, string | undefined>): Promise<string> {
    const saved = process.env["SYL_API_ORIGIN"];
    if (env["SYL_API_ORIGIN"] === undefined) delete process.env["SYL_API_ORIGIN"];
    else process.env["SYL_API_ORIGIN"] = env["SYL_API_ORIGIN"];

    try {
      // Fresh module each time: the target is read from the environment at
      // import, so a cached module would answer for whichever test ran first.
      // The path must be a static literal — a template string is not
      // statically analysable and fails as "unknown variable dynamic import".
      vi.resetModules();
      const mod = await import("../../vite.config.ts");
      const config = mod.default as {
        server?: { proxy?: Record<string, { target?: string }> };
      };
      const target = config.server?.proxy?.["/api"]?.target;
      expect(target, "the /api proxy entry should exist").toBeTypeOf("string");
      return target as string;
    } finally {
      if (saved === undefined) delete process.env["SYL_API_ORIGIN"];
      else process.env["SYL_API_ORIGIN"] = saved;
    }
  }

  it("should default to Syl's own service port", async () => {
    expect(await loadTarget({ SYL_API_ORIGIN: undefined })).toContain("8888");
  });

  it("should never default to Adjutant's backend port", async () => {
    // The specific regression. 4201 is Adjutant; sending Syl's admin there
    // yields HTML error pages rather than a connection failure.
    expect(await loadTarget({ SYL_API_ORIGIN: undefined })).not.toContain("4201");
  });

  it("should address the loopback by literal IPv4, not by name", async () => {
    // DEFAULT_HOST is 127.0.0.1. Node resolves "localhost" with Happy Eyeballs
    // and can pick ::1, which nothing is listening on.
    const target = await loadTarget({ SYL_API_ORIGIN: undefined });

    expect(target).toContain("127.0.0.1");
    expect(target).not.toContain("localhost");
  });

  it("should let SYL_API_ORIGIN override the default", async () => {
    expect(await loadTarget({ SYL_API_ORIGIN: "http://127.0.0.1:4210" })).toBe(
      "http://127.0.0.1:4210",
    );
  });
});
