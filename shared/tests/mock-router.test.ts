import { describe, expect, it } from "vitest";

import { API_BASE, matchRoute, pathExists, specRoutes, WS_PATH } from "../src/mock/router.js";
import { loadSpec } from "../src/spec.js";

describe("specRoutes", () => {
  const routes = specRoutes();

  it("should derive one route per operation in the contract", () => {
    const declared: string[] = [];
    for (const operations of Object.values(loadSpec().paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const id = (operation as { operationId?: string }).operationId;
        if (id !== undefined) declared.push(id);
      }
    }
    expect(routes.map((r) => r.operationId).sort()).toEqual(declared.sort());
    expect(declared.length).toBeGreaterThan(30);
  });

  it("should mark exactly the writes as idempotent", () => {
    const idempotent = routes.filter((r) => r.idempotent);
    expect(idempotent.length).toBeGreaterThan(5);
    // Every write takes a key; no read does.
    expect(idempotent.every((r) => r.method !== "GET")).toBe(true);
    expect(routes.filter((r) => r.method === "GET").every((r) => !r.idempotent)).toBe(true);
  });
});

describe("matchRoute", () => {
  it("should match a literal path", () => {
    expect(matchRoute("GET", "/health")?.route.operationId).toBe("getHealth");
  });

  it("should extract a path parameter", () => {
    const match = matchRoute("GET", "/reminders/syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f");
    expect(match?.route.operationId).toBe("getReminder");
    // Ids contain colons, so the segment pattern must not be a word class.
    expect(match?.params["reminderId"]).toBe("syl:reminder:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f");
  });

  it("should prefer a literal sub-path over a parameter that would swallow it", () => {
    // `/reminders/{id}/snooze` must not lose to anything treating `snooze`
    // as an id.
    const match = matchRoute("POST", "/reminders/syl:reminder:abc/snooze");
    expect(match?.route.operationId).toBe("snoozeReminder");
    expect(match?.params["reminderId"]).toBe("syl:reminder:abc");
  });

  it("should distinguish methods on the same path", () => {
    expect(matchRoute("GET", "/reminders")?.route.operationId).toBe("listReminders");
    expect(matchRoute("POST", "/reminders")?.route.operationId).toBe("createReminder");
  });

  it("should be case-insensitive about the method", () => {
    expect(matchRoute("get", "/health")?.route.operationId).toBe("getHealth");
  });

  it("should return undefined for an unknown path", () => {
    expect(matchRoute("GET", "/nope")).toBeUndefined();
  });

  it("should not match a partial path", () => {
    expect(matchRoute("GET", "/health/extra")).toBeUndefined();
  });

  it("should decode a percent-encoded parameter", () => {
    expect(matchRoute("GET", "/reminders/a%20b")?.params["reminderId"]).toBe("a b");
  });
});

describe("pathExists", () => {
  it("should tell 405 from 404, so a typo is diagnosed as the right kind of mistake", () => {
    expect(pathExists("/health")).toBe(true);
    expect(matchRoute("DELETE", "/health")).toBeUndefined();
    expect(pathExists("/nope")).toBe(false);
  });
});

describe("mount points", () => {
  it("should agree with the servers block in the spec", () => {
    const url = (loadSpec() as unknown as { servers: { url: string }[] }).servers[0]?.url ?? "";
    expect(url.endsWith(API_BASE)).toBe(true);
  });

  it("should put the socket under the same base", () => {
    expect(WS_PATH.startsWith(API_BASE)).toBe(true);
  });
});
