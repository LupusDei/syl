import { API_BASE, WS_PATH } from "../mock/router.js";
import { startMockServer } from "../mock/server.js";

/**
 * `npm run mock` — serve the contract from the fixtures.
 *
 * Thin on purpose: argv in, server up. The behaviour worth testing lives in
 * `mock/`, which is exercised without binding a port.
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function num(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const scenario: Record<string, number> = {};
const latency = num("latency");
if (latency !== undefined) scenario["latencyMs"] = latency;
const jitter = num("jitter");
if (jitter !== undefined) scenario["jitterMs"] = jitter;
const errorRate = num("error-rate");
if (errorRate !== undefined) scenario["errorRate"] = errorRate;
const seed = num("seed");
if (seed !== undefined) scenario["seed"] = seed;

const port = num("port") ?? Number(process.env["MOCK_PORT"] ?? 4210);

const server = await startMockServer({ port, scenario });
const base = `http://127.0.0.1:${server.port}`;

console.log(`
  Syl mock server

    HTTP       ${base}${API_BASE}
    WebSocket  ws://127.0.0.1:${server.port}${WS_PATH}

  Served from shared/fixtures/. Writes echo your own clientId and change what
  later reads return, so optimistic send and cursor sync are both testable.

  Scripting — none of these are delayed or faulted themselves:

    GET    /__mock/routes        every operation in the contract
    GET    /__mock/state         row counts, socket count, last seq
    GET    /__mock/scenario      current latency and failure settings
    POST   /__mock/scenario      { latencyMs, jitterMs, errorRate, failNext,
                                   error, status, offline, seed }
    DELETE /__mock/scenario      back to defaults
    POST   /__mock/reset         reseed the store, clear idempotency keys
    POST   /__mock/presence      { state, intensity, ttl_ms } — unnumbered
    POST   /__mock/broadcast     { fixture } — numbered and replayable
    POST   /__mock/disconnect    drop every socket, to exercise replay

  Per-request overrides, so one slow call does not need global state:

    X-Mock-Latency-Ms: 2000
    X-Mock-Error: RATE_LIMITED
    X-Mock-Status: 429

  Try:

    curl -s ${base}${API_BASE}/health
    curl -s -X POST ${base}/__mock/scenario -d '{"failNext":3,"error":"UPSTREAM_UNAVAILABLE"}'
    curl -s -X POST ${base}/__mock/scenario -d '{"offline":true}'   # tunnel down

  Ctrl-C to stop.
`);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
