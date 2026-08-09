import { describe, expect, it } from "vitest";

import type { SchemaRegistry } from "../src/schema.js";
import { validate, validateOrThrow } from "../src/validate.js";

const registry: SchemaRegistry = {
  Id: { type: "string", pattern: "^syl:[a-z]+:[0-9]+$" },
  Instant: { type: "string", format: "date-time" },
  Role: { type: "string", enum: ["user", "assistant"] },
  Nullable: { type: ["string", "null"] },
  Message: {
    type: "object",
    required: ["id", "role", "clientId"],
    properties: {
      id: { $ref: "#/components/schemas/Id" },
      role: { $ref: "#/components/schemas/Role" },
      clientId: { type: ["string", "null"] },
      seq: { type: "integer", minimum: 1 },
    },
  },
  Page: {
    type: "object",
    required: ["items"],
    properties: {
      items: { type: "array", items: { $ref: "#/components/schemas/Message" } },
    },
  },
  Ok: { type: "object", required: ["success"], properties: { success: { const: true } } },
  Wrapped: {
    allOf: [
      { $ref: "#/components/schemas/Ok" },
      { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/Message" } } },
    ],
  },
  Either: {
    oneOf: [{ $ref: "#/components/schemas/Message" }, { $ref: "#/components/schemas/Page" }],
  },
  Bag: { type: "object", additionalProperties: true },
  Closed: {
    type: "object",
    required: [],
    properties: { a: { type: "string" } },
    additionalProperties: false,
  },
};

const message = { id: "syl:message:1", role: "user", clientId: null, seq: 3 };

describe("validate", () => {
  it("should accept a value that satisfies every keyword", () => {
    expect(validate(registry, "Message", message)).toEqual([]);
  });

  it("should report the path of a nested failure rather than only the root", () => {
    const errors = validate(registry, "Page", { items: [message, { ...message, role: "ghost" }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("$.items[1].role");
    expect(errors[0]?.message).toMatch(/enum/i);
  });

  it("should report every missing required property, not just the first", () => {
    const errors = validate(registry, "Message", { seq: 1 });
    expect(errors.map((e) => e.path).sort()).toEqual(["$.clientId", "$.id", "$.role"]);
  });

  it("should accept null for a union type that includes null", () => {
    expect(validate(registry, "Nullable", null)).toEqual([]);
    expect(validate(registry, "Nullable", "text")).toEqual([]);
    expect(validate(registry, "Nullable", 3)).toHaveLength(1);
  });

  it("should distinguish integer from number", () => {
    expect(validate(registry, "Message", { ...message, seq: 2.5 })).toHaveLength(1);
  });

  it("should enforce minimum", () => {
    expect(validate(registry, "Message", { ...message, seq: 0 })).toHaveLength(1);
  });

  it("should enforce pattern", () => {
    expect(validate(registry, "Message", { ...message, id: "message:1" })).toHaveLength(1);
  });

  it("should reject a bare date-like string that is not RFC 3339 UTC", () => {
    expect(validate(registry, "Instant", "2026-08-09T07:00:03.114Z")).toEqual([]);
    expect(validate(registry, "Instant", "2026-08-09 07:00:03")).toHaveLength(1);
    expect(validate(registry, "Instant", "2026-08-09T07:00:03.114-05:00")).toHaveLength(1);
  });

  it("should intersect allOf branches", () => {
    expect(validate(registry, "Wrapped", { success: true, data: message })).toEqual([]);
    expect(validate(registry, "Wrapped", { success: false, data: message })).toHaveLength(1);
    expect(validate(registry, "Wrapped", { success: true })).toHaveLength(1);
  });

  it("should require exactly one oneOf branch to match", () => {
    expect(validate(registry, "Either", message)).toEqual([]);
    expect(validate(registry, "Either", { items: [] })).toEqual([]);
    const errors = validate(registry, "Either", { nope: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/no branch/i);
  });

  it("should allow unknown properties by default and reject them when closed", () => {
    expect(validate(registry, "Bag", { anything: 1 })).toEqual([]);
    expect(validate(registry, "Closed", { a: "x" })).toEqual([]);
    const errors = validate(registry, "Closed", { a: "x", b: 2 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("$.b");
  });

  it("should reject an array where an object is required", () => {
    expect(validate(registry, "Message", [])).toHaveLength(1);
  });

  /**
   * `syl-cgt`. `typeOf(undefined)` fell through to `"object"`, so the type
   * check passed, and `checkObject` was guarded on `typeof value === "object"`,
   * which `undefined` fails — so the required properties were never examined
   * either. The value fell between the two and nothing looked at it.
   *
   * The practical consequence: a route answering `{"success": true}` with no
   * payload conformed to every operation in the contract.
   */
  describe("undefined", () => {
    it("should reject undefined against an object schema rather than reporting it clean", () => {
      const errors = validate(registry, "Message", undefined);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe("$");
      expect(errors[0]?.message).toMatch(/undefined/i);
    });

    it("should reject undefined against every other kind of schema too", () => {
      expect(validate(registry, "Id", undefined)).toHaveLength(1);
      expect(validate(registry, "Nullable", undefined)).toHaveLength(1);
      expect(validate(registry, "Page", undefined)).toHaveLength(1);
      expect(validate(registry, "Wrapped", undefined)).toHaveLength(1);
      expect(validate(registry, "Either", undefined)).toHaveLength(1);
      // `Bag` declares no constraint beyond `type: object`, which is the
      // weakest schema in the registry and so the easiest one to slip past.
      expect(validate(registry, "Bag", undefined)).toHaveLength(1);
    });

    it("should distinguish undefined from null", () => {
      // `null` is a value the contract can express and sometimes requires;
      // `undefined` is the absence of one and never travels on the wire.
      expect(validate(registry, "Nullable", null)).toEqual([]);
      expect(validate(registry, "Nullable", undefined)).toHaveLength(1);
    });

    it("should treat a required property present but undefined as missing", () => {
      // `JSON.stringify({ id: undefined })` is `{}`. A value that cannot
      // survive the wire is not a value that satisfies a requirement.
      const errors = validate(registry, "Message", { ...message, id: undefined });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe("$.id");
      expect(errors[0]?.message).toMatch(/missing/i);
    });

    it("should treat an optional property present but undefined as absent", () => {
      expect(validate(registry, "Message", { ...message, seq: undefined })).toEqual([]);
      // ...and not as an unexpected property on a closed schema, for the same
      // reason: it is not there once it is serialised.
      expect(validate(registry, "Closed", { a: "x", b: undefined })).toEqual([]);
    });

    it("should reject an undefined array element", () => {
      const errors = validate(registry, "Page", { items: [message, undefined] });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe("$.items[1]");
    });

    it("should refuse a success envelope carrying no data at all", () => {
      // The failure this bug actually caused, in the shape it caused it.
      const errors = validate(registry, "Wrapped", { success: true, data: undefined });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe("$.data");
    });
  });

  it("should throw for an unknown schema name rather than passing silently", () => {
    expect(() => validate(registry, "Nonexistent", {})).toThrow(/Nonexistent/);
  });

  it("should throw a readable aggregate from validateOrThrow", () => {
    expect(() => validateOrThrow(registry, "Message", { seq: 1 }, "fixture.json")).toThrow(
      /fixture\.json/,
    );
    expect(() => validateOrThrow(registry, "Message", message)).not.toThrow();
  });
});
