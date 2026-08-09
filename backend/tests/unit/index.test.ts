import type { Server } from "node:http";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SylConfig } from "../../src/config.js";
import {
  createApp,
  describeStartup,
  errorStatus,
  onError,
  startServer,
} from "../../src/index.js";
import { startTestApp, wrap, type RunningApp } from "../helpers/http.js";

const config: SylConfig = {
  host: "127.0.0.1",
  // Port 0 asks the kernel for a free one. Tests must never fight over 4201,
  // and never fight each other.
  port: 0,
  nodeEnv: "test",
  version: "0.1.0",
  credentialSource: "none",
  subscriptionRails: true,
};

const started: Server[] = [];
let running: RunningApp | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(
    started.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(overrides: Partial<SylConfig> = {}): Promise<RunningApp> {
  running = await startTestApp(createApp({ ...config, ...overrides }));
  return running;
}

describe("createApp", () => {
  it("should mount the health endpoint under /api", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}/api/health`);

    expect(response.status).toBe(200);
  });

  it("should not advertise the framework in its headers", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}/api/health`);

    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  describe("error path", () => {
    it("should answer an unknown path with a JSON 404, not an HTML page", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}/api/nope`);
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(body.error).toBe("not_found");
    });

    it("should answer a 404 for the bare root as well", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}/`);

      expect(response.status).toBe(404);
    });

    it("should turn a malformed JSON body into a 400, not a stack trace", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}/api/nope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ this is not json",
      });
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("bad_request");
    });

    it("should never echo an error stack to the client", async () => {
      const app = await serve();

      const text = await (
        await fetch(`${app.baseUrl}/api/nope`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{ nope",
        })
      ).text();

      expect(text).not.toMatch(/at .*\.ts:/);
      expect(text).not.toContain("node_modules");
    });
  });

  describe("edge cases", () => {
    it("should carry the configured version through to the health body", async () => {
      const app = await serve({ version: "9.9.9" });

      const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as {
        version: string;
      };

      expect(body.version).toBe("9.9.9");
    });

    it("should carry a compromised credential source through to the health body", async () => {
      const app = await serve({
        credentialSource: "ANTHROPIC_AUTH_TOKEN",
        subscriptionRails: false,
      });

      const body = (await (await fetch(`${app.baseUrl}/api/health`)).json()) as {
        credentialSource: string;
        subscriptionRails: boolean;
      };

      expect(body.credentialSource).toBe("ANTHROPIC_AUTH_TOKEN");
      expect(body.subscriptionRails).toBe(false);
    });
  });
});

describe("errorStatus", () => {
  it("should keep a 4xx status thrown by middleware", () => {
    // The real shape: `express.json()` rejects a bad body with exactly this.
    expect(errorStatus(Object.assign(new Error("Unexpected token"), { status: 400 }))).toBe(400);
    expect(errorStatus(Object.assign(new Error("too large"), { status: 413 }))).toBe(413);
  });

  it("should treat anything without a client-error status as our own fault", () => {
    expect(errorStatus(new Error("boom"))).toBe(500);
    expect(errorStatus(Object.assign(new Error("x"), { status: 500 }))).toBe(500);
    expect(errorStatus(Object.assign(new Error("x"), { status: 302 }))).toBe(500);
    expect(errorStatus(Object.assign(new Error("x"), { status: "400" }))).toBe(500);
  });

  it("should survive a thrown value that is not an object at all", () => {
    expect(errorStatus("a bare string")).toBe(500);
    expect(errorStatus(null)).toBe(500);
    expect(errorStatus(undefined)).toBe(500);
    expect(errorStatus(42)).toBe(500);
  });
});

describe("onError", () => {
  /** A route that throws is the only way to reach the 500 branch honestly. */
  async function serveThrowing(thrown: unknown): Promise<RunningApp> {
    const app = express();
    app.get("/boom", () => {
      throw thrown;
    });
    app.use(onError);
    running = await startTestApp(app);
    return running;
  }

  it("should answer an unhandled throw with a 500 and a code, not internals", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = await serveThrowing(new Error("the database fell over at /Users/Reason/secret"));

    const response = await fetch(`${app.baseUrl}/boom`);
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("internal_error");
    expect(body.message).not.toContain("database");
    expect(body.message).not.toContain("/Users/Reason");
    logged.mockRestore();
  });

  it("should log the detail to stderr, where it is still recoverable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = await serveThrowing(new Error("the database fell over"));

    await fetch(`${app.baseUrl}/boom`);

    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[1])).toContain("the database fell over");
    logged.mockRestore();
  });

  it("should not log a client's own mistake as a service error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = await serveThrowing(Object.assign(new Error("bad body"), { status: 400 }));

    const response = await fetch(`${app.baseUrl}/boom`);

    expect(response.status).toBe(400);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("should not call an unnamed 4xx an internal error", async () => {
    const app = await serveThrowing(Object.assign(new Error("teapot"), { status: 418 }));

    const response = await fetch(`${app.baseUrl}/boom`);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(418);
    expect(body.error).toBe("client_error");
  });
});

describe("describeStartup", () => {
  it("should announce version, address and environment on a clean start", () => {
    const lines = describeStartup({ ...config, port: 4201, version: "1.2.3" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("v1.2.3");
    expect(lines[0]).toContain("http://127.0.0.1:4201");
    expect(lines[0]).toContain("test");
  });

  it("should warn loudly when a metered key is in the environment", () => {
    const lines = describeStartup({
      ...config,
      credentialSource: "ANTHROPIC_API_KEY",
      subscriptionRails: false,
    });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("WARNING");
    expect(lines[1]).toContain("ANTHROPIC_API_KEY");
  });

  it("should never print a credential value, only the variable's name", () => {
    const lines = describeStartup({
      ...config,
      credentialSource: "ANTHROPIC_AUTH_TOKEN",
      subscriptionRails: false,
    });

    expect(lines.join("\n")).not.toMatch(/sk-ant/);
  });
});

describe("startServer", () => {
  it("should resolve only once the socket is accepting connections", async () => {
    const server = await startServer(config);
    started.push(server);

    const response = await fetch(`${wrap(server).baseUrl}/api/health`);

    expect(response.status).toBe(200);
  });

  it("should listen on the configured host and port", async () => {
    const server = await startServer(config);
    started.push(server);

    const address = server.address();

    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    expect((address as { address: string }).address).toBe("127.0.0.1");
  });

  it("should reject rather than hang when the port is already taken", async () => {
    const first = await startServer(config);
    started.push(first);
    const taken = (first.address() as { port: number }).port;

    await expect(startServer({ ...config, port: taken })).rejects.toThrow(/EADDRINUSE/);
  });
});
