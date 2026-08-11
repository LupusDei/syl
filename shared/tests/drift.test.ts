import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderTypes, renderWsJsonSchema } from "../src/generate.js";
import { API_BASE } from "../src/mock/router.js";
import { startMockServer, type MockServer } from "../src/mock/server.js";
import { loadSchemas, loadSpec, TYPES_PATH, WS_FRAME_ROOTS, WS_SCHEMA_PATH } from "../src/spec.js";
import { validate } from "../src/validate.js";

/**
 * The drift gate.
 *
 * `tests/generate.test.ts` proves the generator renders a synthetic registry
 * correctly. That is necessary and it is not the same thing as proving the
 * files on disk match the spec on disk — a spec edit that nobody regenerated
 * passes every test in that file and still ships a lie to three squads.
 *
 * This suite re-renders from `openapi.yaml` and compares byte-for-byte. It is
 * the reason `src/types.ts` and `schemas/ws.json` can be trusted without
 * reading them.
 */
describe("generated artefacts", () => {
  const registry = loadSchemas();

  it("should have src/types.ts identical to a fresh render of the spec", () => {
    const onDisk = readFileSync(TYPES_PATH, "utf8");
    expect(onDisk).toBe(renderTypes(registry));
  });

  it("should have schemas/ws.json identical to a fresh render of the spec", () => {
    const onDisk = readFileSync(WS_SCHEMA_PATH, "utf8");
    expect(onDisk).toBe(renderWsJsonSchema(registry, WS_FRAME_ROOTS));
  });
});

describe("the spec itself", () => {
  const spec = loadSpec();
  const registry = loadSchemas();

  it("should be OpenAPI 3.1", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it("should declare an Idempotency-Key on every write", () => {
    const writes: string[] = [];
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!["post", "put", "patch", "delete"].includes(method)) continue;
        const op = operation as { parameters?: readonly { $ref?: string }[] };
        const label = `${method.toUpperCase()} ${path}`;
        writes.push(label);
        const refs = (op.parameters ?? []).map((p) => p.$ref);
        if (!refs.includes("#/components/parameters/IdempotencyKey")) missing.push(label);
      }
    }

    // A guard on the guard: if the spec stops having writes, this test would
    // pass vacuously and nobody would notice.
    expect(writes.length).toBeGreaterThan(5);
    expect(missing).toEqual([]);
    // ...and a declaration nobody honours is a comment. `an implementation,
    // measured against the contract` below is the half that has teeth.
  });

  it("should keep ttl_ms as the only snake_case field on the wire", () => {
    const offenders: string[] = [];
    for (const [name, node] of Object.entries(registry)) {
      for (const key of Object.keys(node.properties ?? {})) {
        if (key.includes("_") && key !== "ttl_ms") offenders.push(`${name}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(registry["WsPresence"]?.properties?.["ttl_ms"]).toBeDefined();
  });

  it("should never let a presence frame carry a sequence number", () => {
    // Numbering presence would force the server either to replay it (forbidden)
    // or to punch holes in the sequence space, which is how gap detection
    // works. The rule is load-bearing enough to assert rather than document.
    expect(registry["WsPresence"]?.properties?.["seq"]).toBeUndefined();
    expect(registry["WsPresence"]?.required).not.toContain("seq");
  });

  it("should never admit a presence frame into the replay buffer", () => {
    const replayable = registry["WsSyncResponse"]?.properties?.["frames"]?.items?.oneOf ?? [];
    const names = replayable.map((branch) => branch.$ref);
    expect(names).not.toContain("#/components/schemas/WsPresence");
    expect(names.length).toBeGreaterThan(0);
  });

  it("should name the two sync mechanisms apart so they cannot be conflated", () => {
    // `GET /sync` takes `since`; the socket frame takes `sinceSeq`. If either
    // is ever renamed to match the other, a client will use a cursor as a
    // sequence number and silently believe it is caught up.
    const httpSync = spec.paths["/sync"]?.["get"] as {
      parameters?: readonly { name?: string }[];
    };
    const httpParams = (httpSync.parameters ?? []).map((p) => p.name);
    expect(httpParams).toContain("since");
    expect(httpParams).not.toContain("sinceSeq");
    expect(registry["WsSync"]?.required).toContain("sinceSeq");
    expect(registry["WsSync"]?.properties?.["since"]).toBeUndefined();
  });

  it("should require clientId on both send paths", () => {
    expect(registry["SendMessageRequest"]?.required).toContain("clientId");
    expect(registry["WsClientChatMessage"]?.required).toContain("clientId");
    // ...and confirm it back on both, or an optimistic send cannot reconcile.
    expect(registry["DeliveryConfirmation"]?.required).toContain("clientId");
    expect(registry["WsDeliveryConfirmation"]?.required).toContain("clientId");
    expect(registry["WsDeliveryConfirmation"]?.required).toContain("serverId");
  });

  it("should stamp a conversationId on every message", () => {
    expect(registry["Message"]?.required).toContain("conversationId");
  });

  it("should keep deliveredAt and ackedAt distinct on the outbox", () => {
    // APNs accepting a push is not delivery. Collapsing these two fields is
    // the exact mistake the delivery guarantee exists to prevent.
    const delivery = registry["Delivery"]?.properties ?? {};
    expect(delivery["deliveredAt"]).toBeDefined();
    expect(delivery["ackedAt"]).toBeDefined();
  });

  it("should express every instant as UTC with a Z suffix", () => {
    for (const example of registry["Instant"]?.examples ?? []) {
      expect(example).toMatch(/Z$/);
    }
  });

  it("should use only the JSON Schema keywords the validator actually enforces", () => {
    // The validator supports a deliberate subset. Anything outside it is not
    // rejected — it is silently ignored, which means a constraint could be
    // added to the spec, believed, and never checked on either side. This test
    // is what makes "a named subset" honest rather than aspirational: adding
    // `maxItems` to the spec fails here until `validate.ts` implements it.
    const supported = new Set([
      "$ref", "type", "const", "enum", "properties", "required", "items",
      "allOf", "oneOf", "additionalProperties", "format", "pattern",
      "minimum", "maximum", "minLength", "maxLength", "minItems",
      // Documentation only; carried into the generated output, never validated.
      "description", "default", "examples", "summary",
    ]);

    const offenders = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, child] of Object.entries(node)) {
        if (!supported.has(key)) offenders.add(key);
        // `properties` keys are field names, not keywords.
        if (key === "properties" && child !== null && typeof child === "object") {
          Object.values(child).forEach(walk);
        } else {
          walk(child);
        }
      }
    };
    Object.values(registry).forEach(walk);

    expect([...offenders].sort()).toEqual([]);
  });
});

/**
 * Everything above this line reads `openapi.yaml` and asserts things about
 * `openapi.yaml`. That is a real class of drift — a spec edit nobody
 * regenerated — and it is not the class that hurt us.
 *
 * `syl-cgt`: the idempotency test above was the contract validating itself,
 * and it passed on a repository where two write endpoints ignored the header
 * entirely. A rule the spec states and nothing enforces is a comment. So this
 * block boots the mock over a real socket and measures an implementation
 * against the contract, and pins the validator to the failure it exists to
 * catch rather than to a schema of our own invention.
 *
 * The mock is the right subject here because `shared` cannot depend on the
 * backend. The real service is measured the same way, in
 * `backend/tests/integration/contract-conformance.test.ts`.
 */
describe("an implementation, measured against the contract", () => {
  const registry = loadSchemas();
  let server: MockServer;
  let base: string;

  beforeAll(async () => {
    server = await startMockServer({ port: 0, quiet: true });
    base = `http://127.0.0.1:${server.port}${API_BASE}`;
  });

  afterAll(async () => {
    await server.close();
  });

  /** A syntactically valid id for any path parameter the spec names. */
  function fill(template: string): string {
    return template.replace(/\{(\w+?)Id\}/gu, (_match, kind: string) =>
      encodeURIComponent(`syl:${kind}:00000000-0000-7000-8000-0000000000ff`),
    );
  }

  /** Every write the contract declares, as `[operationId, method, template]`. */
  function declaredWrites(): readonly (readonly [string, string, string])[] {
    const writes: (readonly [string, string, string])[] = [];
    for (const [template, operations] of Object.entries(loadSpec().paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!["post", "put", "patch", "delete"].includes(method)) continue;
        const op = operation as { operationId?: string };
        if (op.operationId === undefined) continue;
        writes.push([op.operationId, method.toUpperCase(), template]);
      }
    }
    return writes;
  }

  it("should refuse every declared write that arrives without an Idempotency-Key", async () => {
    const accepted: string[] = [];

    for (const [operationId, method, template] of declaredWrites()) {
      const response = await fetch(`${base}${fill(template)}`, {
        method,
        headers: {
          // Any bearer is accepted by the mock. Authorisation is checked before
          // idempotency, so without one this would measure the wrong refusal.
          Authorization: "Bearer mock-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const body = (await response.json()) as { error?: { code?: string } };
      if (body.error?.code !== "IDEMPOTENCY_KEY_REQUIRED") accepted.push(operationId);
    }

    expect(declaredWrites().length).toBeGreaterThan(5);
    expect(accepted.sort()).toEqual([]);
  });

  it("should replay a repeated write rather than performing it twice", async () => {
    const send = async (): Promise<Response> =>
      fetch(`${base}/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "drift-pair-0001" },
        body: JSON.stringify({ pairingCode: "4821-9930", deviceName: "Drift probe" }),
      });

    const first = await send();
    expect(first.status).toBe(200);

    const retry = await send();
    expect(retry.status).toBe(first.status);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
  });

  it("should not report a missing payload as a conforming success envelope", async () => {
    // `syl-cgt`, against the real registry rather than a synthetic one. The
    // validator used to answer `[]` here, so a route that replied
    // `{"success": true}` and nothing else passed every conformance assertion
    // in this repository.
    expect(validate(registry, "Reminder", undefined)).not.toEqual([]);
    expect(validate(registry, "Delivery", undefined)).not.toEqual([]);
    expect(validate(registry, "SyncResponse", undefined)).not.toEqual([]);

    const envelope: unknown = { success: true };
    // `OkEnvelope` alone is `required: [success]`, so the envelope passes and
    // the per-operation `allOf` branch is what carries `required: [data]`.
    // Validating that branch's target against the absent value is the check
    // that was silently vacuous.
    expect(validate(registry, "OkEnvelope", envelope)).toEqual([]);
    expect(
      validate(registry, "Reminder", (envelope as { data?: unknown }).data),
    ).not.toEqual([]);
  });
});
