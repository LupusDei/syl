import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Express } from "express";

/**
 * Drive the HTTP surface through a real listening socket rather than a
 * request/response double.
 *
 * Supertest-style fakes let a whole class of bug through — header casing,
 * content negotiation, how Express 5 finalises an unmatched route — because
 * they never go over the wire. Node 22 has `fetch` built in and binding port 0
 * is free, so there is no reason to accept that blind spot.
 */
export interface RunningApp {
  /** Origin to fetch against, e.g. `http://127.0.0.1:51234`. */
  readonly baseUrl: string;
  /** Resolves once the socket is fully closed. */
  close(): Promise<void>;
}

/** Start `app` on an ephemeral loopback port. */
export async function startTestApp(app: Express): Promise<RunningApp> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return wrap(server);
}

/** Wrap an already-listening server in the same interface. */
export function wrap(server: Server): RunningApp {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an already-listening TCP server");
  }
  const { port } = address satisfies AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
