import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RunwayClient,
  RUNWAY_API_VERSION,
  isTerminal,
  type SubmitSpec,
} from "../../src/render/runway.js";

/**
 * The one client in this project that talks to a metered API.
 *
 * `docs/VIDEO.md`: renders are billed to the Runway account, not to the
 * subscription rails everything else runs on. **That makes the injected
 * transport a rule rather than a convenience** — no test may reach the network
 * and no test may spend a credit, so `fetch` is a constructor argument and the
 * real one is never the default in a test run.
 *
 * Everything here answers with a value. A throw crossing back into a tool
 * handler reaches the Commander as silence, or as Syl saying she made a video
 * that does not exist.
 */

const SPEC: SubmitSpec = {
  model: "seedance2",
  promptImage: "data:image/png;base64,AAAA",
  promptText: "she turns once",
  ratio: "720:1280",
  duration: 15,
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "syl-runway-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("submitting a render", () => {
  it("should carry the secret and the API version Runway pins on", async () => {
    const seen: { url: string; init: RequestInit | undefined } = { url: "", init: undefined };
    const client = new RunwayClient({
      secret: "sk-test",
      fetch: async (url, init) => {
        seen.url = url;
        seen.init = init;
        return jsonResponse(200, { id: "task-9" });
      },
    });

    const submitted = await client.submit(SPEC);

    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.data.id).toBe("task-9");
    expect(seen.url).toContain("/image_to_video");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["X-Runway-Version"]).toBe(RUNWAY_API_VERSION);
  });

  it("should never put the secret in a message it hands back", async () => {
    // The message goes up the MCP pipe and is written into a sidecar on disk.
    const client = new RunwayClient({
      secret: "sk-super-secret",
      fetch: async () => jsonResponse(401, { error: "bad key" }),
    });

    const submitted = await client.submit(SPEC);

    expect(submitted.ok).toBe(false);
    if (submitted.ok) return;
    expect(submitted.failure.message).not.toContain("sk-super-secret");
  });

  it("should turn a refusal into a sentence rather than throwing", async () => {
    const client = new RunwayClient({
      secret: "sk-test",
      fetch: async () => jsonResponse(402, { error: "out of credits" }),
    });

    const submitted = await client.submit(SPEC);

    expect(submitted.ok).toBe(false);
    if (submitted.ok) return;
    expect(submitted.failure.message).toContain("402");
    expect(submitted.failure.message).toContain("out of credits");
  });

  it("should turn a dead socket into a sentence rather than an unhandled rejection", async () => {
    const client = new RunwayClient({
      secret: "sk-test",
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });

    const submitted = await client.submit(SPEC);

    expect(submitted.ok).toBe(false);
    if (submitted.ok) return;
    expect(submitted.failure.retryable).toBe(true);
    expect(submitted.failure.message).toMatch(/ENOTFOUND|not answering|could not reach/iu);
  });

  it("should refuse a response that succeeded without giving back a task", async () => {
    const client = new RunwayClient({
      secret: "sk-test",
      fetch: async () => jsonResponse(200, { nothing: true }),
    });

    const submitted = await client.submit(SPEC);

    expect(submitted.ok).toBe(false);
  });
});

describe("following a task", () => {
  it("should know which statuses are the end of the story", () => {
    expect(isTerminal("SUCCEEDED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
    expect(isTerminal("CANCELED")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("PENDING")).toBe(false);
    expect(isTerminal("RUNNING")).toBe(false);
  });

  it("should read the output url from either field Runway uses for it", async () => {
    const artifacts = new RunwayClient({
      secret: "sk-test",
      fetch: async () =>
        jsonResponse(200, { id: "t", status: "SUCCEEDED", artifacts: ["https://x.invalid/a.mp4"] }),
    });

    const task = await artifacts.task("t");

    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.data.output).toEqual(["https://x.invalid/a.mp4"]);
  });
});

describe("downloading the finished render", () => {
  it("should write the bytes where it was told and report how many", async () => {
    const client = new RunwayClient({
      secret: "sk-test",
      fetch: async (url) =>
        url.startsWith("https://cdn.invalid")
          ? new Response(new Uint8Array([1, 2, 3, 4, 5]))
          : jsonResponse(200, {}),
    });
    const to = join(directory, "out.mp4");

    const downloaded = await client.download("https://cdn.invalid/x.mp4", to);

    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok) return;
    expect(downloaded.data).toBe(5);
    expect([...readFileSync(to)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("should not leave a truncated file behind when the download refuses", async () => {
    const client = new RunwayClient({
      secret: "sk-test",
      fetch: async () => new Response("nope", { status: 404 }),
    });
    const to = join(directory, "out.mp4");

    const downloaded = await client.download("https://cdn.invalid/x.mp4", to);

    expect(downloaded.ok).toBe(false);
    // A zero-byte mp4 on disk reads to every later check as a finished render.
    expect(() => readFileSync(to)).toThrow();
  });
});
