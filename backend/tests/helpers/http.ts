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

/**
 * A loopback port that is genuinely free, because the KERNEL chose it.
 *
 * ## Why this exists rather than a number
 *
 * Three test files each grew a function called `freePort`, and no two agreed:
 * `39_000 + random(10_000)`, `41_000 + random(15_000)`, and one that bound
 * port 0 correctly and then fell back to a guess. **The name is the defect** —
 * `freePort()` asserts exactly the property it does not provide, which is why
 * five call sites used it without a second thought.
 *
 * Both guesses drew from inside the kernel's own ephemeral range (32768-60999
 * on Linux), so they were not sampling unused ports at all — they were sampling
 * the pool every outbound socket in the suite is already drawing from.
 *
 * It failed CI twice on 2026-08-23, and the two failures looked nothing alike:
 * a loud `EADDRINUSE 127.0.0.1:39868` from `service-lifecycle`, and
 * `nothing bound 127.0.0.1:53040 within 40000ms` from `verify-script`, whose
 * stub is spawned with `stdio: "ignore"` so the bind error went nowhere. Same
 * bug; one named itself and one cost an evening.
 *
 * ## What it does and does not promise
 *
 * Binding port 0 asks the OS for one it is not currently handing out, which is
 * a real answer rather than a hope. There is still a gap between closing this
 * probe and the caller binding — unavoidable when the thing that binds is a
 * child process — but the OS does not immediately recycle a port it has just
 * released, so the window is small and, unlike a guess, it does not get worse
 * as the suite gets busier.
 *
 * **When the caller controls the child, prefer having the CHILD bind 0 and
 * report the port it got.** That has no window at all. `verify-script.test.ts`
 * does exactly that; this is for the callers that must know the port first.
 */
export async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the probe socket reported no port"));
        return;
      }
      resolve((address satisfies AddressInfo).port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
