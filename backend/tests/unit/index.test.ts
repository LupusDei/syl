import type { ApiError, HealthStatus } from "@syl/shared";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SylConfig } from "../../src/config.js";
import {
  API_BASE_PATH,
  bootstrap,
  clientErrorStatus,
  createApp,
  describeStartup,
  onError,
  startServer,
  toFailure,
  type AppDependencies,
  type RunningService,
} from "../../src/index.js";
import { ApiFailure } from "../../src/routes/envelope.js";
import type { SylDatabase } from "../../src/services/database.js";
import { WS_PATH } from "../../src/services/ws-server.js";
import { startTestApp, wrap, type RunningApp } from "../helpers/http.js";
import { TestClient } from "../helpers/ws.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

const config: SylConfig = testConfig();

/** Either envelope, as a test reads it. */
interface Envelope<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

const started: RunningService[] = [];
let running: RunningApp | undefined;
let db: SylDatabase | undefined;

/** The dependencies `createApp` needs, on a fresh in-memory store. */
function deps(): AppDependencies {
  db?.close();
  db = testDatabase();
  return testDeps(db);
}

afterEach(async () => {
  await running?.close();
  running = undefined;
  db?.close();
  db = undefined;
  await Promise.all(started.splice(0).map((service) => service.close()));
});

async function serve(overrides: Partial<SylConfig> = {}): Promise<RunningApp> {
  running = await startTestApp(createApp({ ...config, ...overrides }, deps()));
  return running;
}

describe("createApp", () => {
  it("should mount the health endpoint under the contract's base path", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/health`);

    expect(response.status).toBe(200);
  });

  it("should not advertise the framework in its headers", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/health`);

    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  describe("error path", () => {
    it("should answer an unknown path with a JSON 404, not an HTML page", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/nope`);
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe("NOT_FOUND");
      expect(body.error?.retryable).toBe(false);
    });

    it("should answer a 404 for the bare root as well", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}/`);

      expect(response.status).toBe(404);
    });

    it("should turn a malformed JSON body into a 400, not a stack trace", async () => {
      const app = await serve();

      const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/nope`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ this is not json",
      });
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(400);
      expect(body.error?.code).toBe("VALIDATION_FAILED");
    });

    it("should never echo an error stack to the client", async () => {
      const app = await serve();

      const text = await (
        await fetch(`${app.baseUrl}${API_BASE_PATH}/nope`, {
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

      const body = (await (
        await fetch(`${app.baseUrl}${API_BASE_PATH}/health`)
      ).json()) as Envelope<{ version: string }>;

      expect(body.data?.version).toBe("9.9.9");
    });

    it("should carry a compromised credential source through to the health body", async () => {
      const app = await serve({
        credentialSource: "ANTHROPIC_AUTH_TOKEN",
        subscriptionRails: false,
      });

      const body = (await (
        await fetch(`${app.baseUrl}${API_BASE_PATH}/health`)
      ).json()) as Envelope<HealthStatus>;

      expect(body.data?.status).toBe("degraded");
      expect(JSON.stringify(body.data?.checks)).toContain("ANTHROPIC_AUTH_TOKEN");
    });

    it("should answer every path in one of the contract's two envelopes", async () => {
      // A client that cannot parse one of the two is entitled to conclude it
      // is not talking to Syl at all — which is only useful if it is true.
      const app = await serve();

      for (const path of [`${API_BASE_PATH}/health`, `${API_BASE_PATH}/nope`, "/"]) {
        const body = (await (await fetch(`${app.baseUrl}${path}`)).json()) as Envelope;
        expect(typeof body.success).toBe("boolean");
        expect(body.success ? body.data !== undefined : body.error !== undefined).toBe(true);
      }
    });
  });
});

describe("clientErrorStatus", () => {
  it("should keep a 4xx status thrown by middleware", () => {
    // The real shape: `express.json()` rejects a bad body with exactly this.
    expect(clientErrorStatus(Object.assign(new Error("Unexpected token"), { status: 400 }))).toBe(
      400,
    );
    expect(clientErrorStatus(Object.assign(new Error("too large"), { status: 413 }))).toBe(413);
  });

  it("should treat anything without a client-error status as our own fault", () => {
    expect(clientErrorStatus(new Error("boom"))).toBeNull();
    expect(clientErrorStatus(Object.assign(new Error("x"), { status: 500 }))).toBeNull();
    expect(clientErrorStatus(Object.assign(new Error("x"), { status: 302 }))).toBeNull();
    expect(clientErrorStatus(Object.assign(new Error("x"), { status: "400" }))).toBeNull();
  });

  it("should survive a thrown value that is not an object at all", () => {
    expect(clientErrorStatus("a bare string")).toBeNull();
    expect(clientErrorStatus(null)).toBeNull();
    expect(clientErrorStatus(undefined)).toBeNull();
    expect(clientErrorStatus(42)).toBeNull();
  });
});

describe("toFailure", () => {
  it("should pass an ApiFailure through unchanged", () => {
    const failure = new ApiFailure("QUIET_HOURS", "not now");

    expect(toFailure(failure)).toBe(failure);
  });

  it("should name an oversized body rather than calling it our bug", () => {
    const failure = toFailure(Object.assign(new Error("too large"), { status: 413 }));

    expect(failure.code).toBe("VALIDATION_FAILED");
    expect(failure.message).toMatch(/larger/);
  });

  it("should treat anything unrecognised as INTERNAL and retryable", () => {
    const failure = toFailure(new Error("boom"));

    expect(failure.code).toBe("INTERNAL");
    expect(failure.status).toBe(500);
    expect(failure.toApiError().retryable).toBe(true);
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
    const body = (await response.json()) as Envelope;

    expect(response.status).toBe(500);
    expect(body.error?.code).toBe("INTERNAL");
    expect(body.error?.message).not.toContain("database");
    expect(body.error?.message).not.toContain("/Users/Reason");
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
    const body = (await response.json()) as Envelope;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_FAILED");
  });

  it("should render a thrown ApiFailure with its own code and status", async () => {
    const app = await serveThrowing(new ApiFailure("DEFERRAL_NOT_LATER", "that is not later"));

    const response = await fetch(`${app.baseUrl}/boom`);
    const body = (await response.json()) as Envelope;

    expect(response.status).toBe(422);
    expect(body.error?.code).toBe("DEFERRAL_NOT_LATER");
    expect(body.error?.message).toBe("that is not later");
  });
});

describe("describeStartup", () => {
  it("should tell the Commander how to pair when nothing is paired yet", () => {
    // A service nobody can talk to, with no instructions on screen, is a
    // service that looks broken.
    const lines = describeStartup(config, { pairingCode: "4821-9930" });

    expect(lines.join("\n")).toContain("4821-9930");
    expect(lines.join("\n")).toContain("/auth/pair");
  });

  it("should say nothing about pairing once a device is paired", () => {
    expect(describeStartup(config).join("\n")).not.toContain("Pairing code");
  });

  it("should announce version, address and environment on a clean start", () => {
    const lines = describeStartup({ ...config, port: 4201, version: "1.2.3" });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("v1.2.3");
    expect(lines[0]).toContain("http://127.0.0.1:4201");
    expect(lines[0]).toContain("test");
    expect(lines[1]).toContain("ws://127.0.0.1:4201/api/v1/ws");
  });

  it("should warn loudly when a metered key is in the environment", () => {
    const lines = describeStartup({
      ...config,
      credentialSource: "ANTHROPIC_API_KEY",
      subscriptionRails: false,
    });

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("WARNING");
    expect(lines.join("\n")).toContain("ANTHROPIC_API_KEY");
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

describe("bootstrap", () => {
  it("should open the store, migrate it, and hand back a usable app", async () => {
    const built = bootstrap(testConfig({ databasePath: ":memory:" }));
    try {
      running = await startTestApp(createApp(config, built.deps));

      const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/health`);
      const body = (await response.json()) as Envelope<HealthStatus>;

      expect(body.data?.checks.map((check) => check.name)).toContain("database");
      expect(body.data?.status).toBe("ok");
    } finally {
      built.database.close();
    }
  });

  it("should give the app a key service backed by that same store", () => {
    const built = bootstrap(testConfig({ databasePath: ":memory:" }));
    try {
      const grant = built.deps.keys.pair(
        built.deps.keys.issuePairingCode().code,
        "Commander's iPhone",
      );

      expect(built.deps.keys.verify(grant.token).ok).toBe(true);
      expect(
        built.database.handle.prepare("SELECT count(*) AS n FROM api_keys").get(),
      ).toEqual({ n: 1 });
    } finally {
      built.database.close();
    }
  });
});

describe("startServer", () => {
  it("should resolve only once the socket is accepting connections", async () => {
    const service = await startServer(config, deps());
    started.push(service);

    const response = await fetch(`${wrap(service.server).baseUrl}${API_BASE_PATH}/health`);

    expect(response.status).toBe(200);
  });

  it("should listen on the configured host and port", async () => {
    const service = await startServer(config, deps());
    started.push(service);

    const address = service.server.address();

    expect(address).not.toBeNull();
    expect(typeof address).toBe("object");
    expect((address as { address: string }).address).toBe("127.0.0.1");
  });

  it("should reject rather than hang when the port is already taken", async () => {
    const first = await startServer(config, deps());
    started.push(first);
    const taken = (first.server.address() as { port: number }).port;

    await expect(startServer({ ...config, port: taken }, deps())).rejects.toThrow(/EADDRINUSE/);
  });

  it("should put the websocket on the same port as the API", async () => {
    // Same origin, same bearer token, one thing to expose over the tunnel.
    const service = await startServer(config, deps());
    started.push(service);
    const port = (service.server.address() as { port: number }).port;

    const client = await TestClient.connect(`ws://127.0.0.1:${port}${WS_PATH}`);
    try {
      expect((await client.next()).type).toBe("auth_challenge");
    } finally {
      client.close();
    }
  });
});
