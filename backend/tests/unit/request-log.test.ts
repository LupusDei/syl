import { connect } from "node:net";

import express, { type Express } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, createApp } from "../../src/index.js";
import { logRequests, REQUEST_EVENT } from "../../src/middleware/request-log.js";
import { createMemoryLogger, type LogRecord } from "../../src/ops/logging.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * One line per request, and what it is deliberately not allowed to say.
 *
 * This exists because of a three-day data loss that could not be diagnosed from
 * the server at all: the Commander's to-do completions stopped arriving, and
 * the question "did his phone reach us and fail, or never leave the phone?" had
 * no answer anywhere. The log's silence meant both, so nobody could tell which
 * half of the system to look at.
 *
 * The other half of the file is the restraint. This log is written to a file
 * the Commander reads and that `GET /logs` serves, so what it must NEVER carry
 * matters as much as what it carries: no bodies, no headers beyond the
 * idempotency key, and **no query strings** — see the test that pins that.
 */

/** Run one request against an app wired to a memory logger, and read the lines. */
async function record(
  build: (app: Express) => void,
  request: (baseUrl: string) => Promise<unknown>,
  quiet: readonly string[] = [],
): Promise<{ readonly lines: readonly LogRecord[] }> {
  const logger = createMemoryLogger();
  const app = express();
  app.use(logRequests({ log: logger, quiet }));
  build(app);

  let running: RunningApp | undefined;
  try {
    running = await startTestApp(app);
    await request(running.baseUrl);
    // `close` on the response fires after the socket is done, which can be a
    // tick behind `fetch` resolving. One turn of the loop, rather than a sleep.
    await new Promise((resolve) => setImmediate(resolve));
    return { lines: logger.records.filter((line) => line.event === REQUEST_EVENT) };
  } finally {
    await running?.close();
  }
}

describe("logRequests", () => {
  it("should record the method, the path, the status and how long it took", async () => {
    const { lines } = await record(
      (app) => {
        app.get("/api/v1/todos/abc/complete", (_request, response) => {
          response.status(200).json({ success: true });
        });
      },
      async (baseUrl) => fetch(`${baseUrl}/api/v1/todos/abc/complete`),
    );

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.method).toBe("GET");
    expect(line?.path).toBe("/api/v1/todos/abc/complete");
    expect(line?.status).toBe(200);
    expect(typeof line?.ms).toBe("number");
    expect(line?.level).toBe("info");
  });

  it("should record the idempotency key, so one write can be followed across retries", async () => {
    const { lines } = await record(
      (app) => {
        app.post("/api/v1/todos", (_request, response) => {
          response.status(201).json({ success: true });
        });
      },
      async (baseUrl) =>
        fetch(`${baseUrl}/api/v1/todos`, {
          method: "POST",
          headers: { "Idempotency-Key": "key-00000001" },
        }),
    );

    expect(lines[0]?.idempotencyKey).toBe("key-00000001");
  });

  it("should omit the idempotency key rather than writing a null when there is none", async () => {
    const { lines } = await record(
      (app) => {
        app.get("/api/v1/sync", (_request, response) => {
          response.status(200).json({ success: true });
        });
      },
      async (baseUrl) => fetch(`${baseUrl}/api/v1/sync`),
    );

    expect(lines[0]).not.toHaveProperty("idempotencyKey");
  });

  it("should never write the query string, the body, or anything credential-shaped", async () => {
    // The destination is a file he reads. A blanket "log the URL" is one route
    // away from putting a token on a line forever, so the query string is
    // dropped wholesale rather than filtered — a filter guards the names
    // somebody thought of.
    const { lines } = await record(
      (app) => {
        app.post("/api/v1/sync", (_request, response) => {
          response.status(200).json({ success: true });
        });
      },
      async (baseUrl) =>
        fetch(`${baseUrl}/api/v1/sync?since=2026-08-25T15:51:44.792Z&token=hunter2`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer syl-secret-token",
          },
          body: JSON.stringify({ passphrase: "correct horse battery staple" }),
        }),
    );

    const rendered = JSON.stringify(lines);
    expect(lines[0]?.path).toBe("/api/v1/sync");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("syl-secret-token");
    expect(rendered).not.toContain("correct horse battery staple");
    expect(rendered).not.toContain("since=");
  });

  it("should log a request that matched no route, because that is the interesting one", async () => {
    // "His phone called a path this build does not serve" is precisely the
    // diagnosis that was unavailable. A 404 that goes unlogged is the silence
    // this middleware exists to end.
    const { lines } = await record(
      () => undefined,
      async (baseUrl) => fetch(`${baseUrl}/api/v1/todos/abc/complete`),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe(404);
  });

  it("should raise the level for a server error, so a failing write is greppable", async () => {
    const { lines } = await record(
      (app) => {
        app.get("/api/v1/todos", (_request, response) => {
          response.status(500).json({ success: false });
        });
      },
      async (baseUrl) => fetch(`${baseUrl}/api/v1/todos`),
    );

    expect(lines[0]?.level).toBe("error");
  });

  it("should keep the health poll at debug, so a watchdog cannot drown the log", async () => {
    // Below the default threshold, so the line exists in the code and not in
    // the file. Quiet by configuration rather than by omission: raise the level
    // and the poll is there.
    const { lines } = await record(
      (app) => {
        app.get("/api/v1/health", (_request, response) => {
          response.status(200).json({ success: true });
        });
      },
      async (baseUrl) => fetch(`${baseUrl}/api/v1/health`),
      ["/api/v1/health"],
    );

    expect(lines[0]?.level).toBe("debug");
  });

  it("should still write a line when the client goes away before the answer", async () => {
    // The case that matters most for "did his phone reach us": the request
    // arrived and the connection died. `finish` never fires for it, so a
    // middleware listening on `finish` alone reports exactly nothing about the
    // requests most likely to be lost.
    //
    // A raw socket rather than `fetch`, for two reasons. It is what a hung-up
    // client actually is, and `fetch` opens a second, idle connection that
    // `server.close()` then waits four seconds for — a four-second unit test
    // bought nothing here.
    let arrived: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });

    const { lines } = await record(
      (app) => {
        app.get("/api/v1/sync", () => {
          // Never answers.
          arrived?.();
        });
      },
      async (baseUrl) => {
        const { port } = new URL(baseUrl);
        const socket = connect(Number(port), "127.0.0.1");
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        socket.write("GET /api/v1/sync HTTP/1.1\r\nHost: syl.test\r\n\r\n");
        await reached;
        socket.destroy();
        // The server sees the reset a tick after the client goes.
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.aborted).toBe(true);
    expect(lines[0]?.level).toBe("warn");
  });
});

describe("createApp", () => {
  let running: RunningApp | undefined;
  let db: SylDatabase | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
    db?.handle.close();
    db = undefined;
  });

  it("should log a request against the real app, not merely own a middleware", async () => {
    // The seam, not the unit. Three separate things in this service were
    // "constructed and connected to nothing" at once, and the convention that
    // caught them is that bootstrap must wire everything. A middleware that
    // exists and is never mounted is that failure exactly, and every test above
    // it would still be green.
    const logger = createMemoryLogger();
    db = testDatabase();
    running = await startTestApp(createApp(testConfig(), { ...testDeps(db), log: logger }));

    // Unauthenticated on purpose: the line has to be written whatever the
    // answer was. A log that only records the requests that succeeded cannot
    // answer the question it exists for.
    await fetch(`${running.baseUrl}${API_BASE_PATH}/todos`);
    await new Promise((resolve) => setImmediate(resolve));

    const lines = logger.records.filter((line) => line.event === REQUEST_EVENT);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.method).toBe("GET");
    expect(lines[0]?.path).toBe(`${API_BASE_PATH}/todos`);
    expect(lines[0]?.status).toBe(401);
  });

  it("should serve requests silently when nobody handed it a logger", async () => {
    // The default for a unit test, and it must stay the default: a suite that
    // wrote into `~/Library/Logs/Syl` would be a suite that rotates the file
    // the Commander is reading.
    db = testDatabase();
    running = await startTestApp(createApp(testConfig(), testDeps(db)));

    const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/todos`);
    expect(response.status).toBe(401);
  });
});
