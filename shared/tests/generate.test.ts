import { describe, expect, it } from "vitest";

import { renderTypes, renderWsJsonSchema, typeExpression } from "../src/generate.js";
import type { SchemaRegistry } from "../src/schema.js";
import { reachableSchemas } from "../src/schema.js";

const registry: SchemaRegistry = {
  Id: { type: "string", description: "An id." },
  Role: { type: "string", enum: ["user", "assistant"] },
  Message: {
    type: "object",
    required: ["id", "role", "clientId"],
    properties: {
      id: { $ref: "#/components/schemas/Id" },
      role: { $ref: "#/components/schemas/Role" },
      clientId: { type: ["string", "null"] },
      seq: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
  },
  Bag: { type: "object", additionalProperties: true },
  Ok: { type: "object", required: ["success"], properties: { success: { const: true } } },
  Wrapped: {
    allOf: [
      { $ref: "#/components/schemas/Ok" },
      { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/Message" } } },
    ],
  },
  Either: {
    oneOf: [{ $ref: "#/components/schemas/Message" }, { $ref: "#/components/schemas/Bag" }],
  },
  Aliased: { allOf: [{ $ref: "#/components/schemas/Id" }], description: "Just an Id." },
  Unconstrained: {},
};

describe("typeExpression", () => {
  it("should render a $ref as the referenced type name", () => {
    expect(typeExpression({ $ref: "#/components/schemas/Id" })).toBe("Id");
  });

  it("should render a string enum as a literal union", () => {
    expect(typeExpression(registry["Role"] as never)).toBe('"user" | "assistant"');
  });

  it("should render a nullable scalar as a union with null", () => {
    expect(typeExpression({ type: ["string", "null"] })).toBe("string | null");
  });

  it("should render integer and number both as number", () => {
    expect(typeExpression({ type: "integer" })).toBe("number");
    expect(typeExpression({ type: "number" })).toBe("number");
  });

  it("should render an array as T[]", () => {
    expect(typeExpression({ type: "array", items: { type: "string" } })).toBe("string[]");
  });

  it("should render a const as its literal", () => {
    expect(typeExpression({ const: true })).toBe("true");
    expect(typeExpression({ const: "presence" })).toBe('"presence"');
  });

  it("should render allOf as an intersection and collapse a single-branch allOf", () => {
    expect(typeExpression(registry["Wrapped"] as never)).toBe(
      "Ok & { readonly data: Message }",
    );
    expect(typeExpression(registry["Aliased"] as never)).toBe("Id");
  });

  it("should render oneOf as a union", () => {
    expect(typeExpression(registry["Either"] as never)).toBe("Message | Bag");
  });

  it("should mark non-required properties optional and required ones not", () => {
    const rendered = typeExpression(registry["Message"] as never);
    expect(rendered).toContain("readonly id: Id");
    expect(rendered).toContain("readonly clientId: string | null");
    expect(rendered).toContain("readonly seq?: number");
  });

  it("should render an open object as an index signature", () => {
    expect(typeExpression(registry["Bag"] as never)).toBe("{ readonly [key: string]: unknown }");
  });

  it("should fall back to unknown rather than inventing a type", () => {
    expect(typeExpression(registry["Unconstrained"] as never)).toBe("unknown");
  });
});

describe("renderTypes", () => {
  const source = renderTypes(registry);

  it("should emit one exported type per schema, in registry order", () => {
    for (const name of Object.keys(registry)) {
      expect(source).toContain(`export type ${name} =`);
    }
    expect(source.indexOf("export type Id =")).toBeLessThan(source.indexOf("export type Role ="));
  });

  it("should emit the envelope helpers the spec describes but cannot name", () => {
    expect(source).toContain("export type Ok<T>");
    expect(source).toContain("export type Envelope<T>");
  });

  it("should warn that the file is generated", () => {
    expect(source.slice(0, 400)).toMatch(/generated/i);
    expect(source.slice(0, 400)).toContain("openapi.yaml");
  });

  it("should carry a schema description through as a doc comment", () => {
    expect(source).toContain("An id.");
  });

  it("should be deterministic", () => {
    expect(renderTypes(registry)).toBe(source);
  });
});

describe("renderWsJsonSchema", () => {
  const registryWithFrames: SchemaRegistry = {
    ...registry,
    WsPing: { type: "object", required: ["type"], properties: { type: { const: "ping" } } },
    WsPong: { type: "object", required: ["type"], properties: { type: { const: "pong" } } },
    WsClientFrame: { oneOf: [{ $ref: "#/components/schemas/WsPing" }] },
    WsServerFrame: { oneOf: [{ $ref: "#/components/schemas/WsPong" }] },
  };

  it("should include only the frame closure, not the whole registry", () => {
    const bundle = JSON.parse(
      renderWsJsonSchema(registryWithFrames, ["WsClientFrame", "WsServerFrame"]),
    ) as { $defs: Record<string, unknown> };
    expect(Object.keys(bundle.$defs).sort()).toEqual([
      "WsClientFrame",
      "WsPing",
      "WsPong",
      "WsServerFrame",
    ]);
  });

  it("should rewrite component refs into local $defs refs", () => {
    const text = renderWsJsonSchema(registryWithFrames, ["WsClientFrame", "WsServerFrame"]);
    expect(text).not.toContain("#/components/schemas/");
    expect(text).toContain("#/$defs/WsPing");
  });

  it("should declare the 2020-12 dialect and both roots", () => {
    const bundle = JSON.parse(
      renderWsJsonSchema(registryWithFrames, ["WsClientFrame", "WsServerFrame"]),
    ) as { $schema: string; oneOf: readonly { $ref: string }[] };
    expect(bundle.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(bundle.oneOf.map((r) => r.$ref)).toEqual([
      "#/$defs/WsClientFrame",
      "#/$defs/WsServerFrame",
    ]);
  });

  it("should be deterministic", () => {
    const once = renderWsJsonSchema(registryWithFrames, ["WsClientFrame", "WsServerFrame"]);
    expect(renderWsJsonSchema(registryWithFrames, ["WsClientFrame", "WsServerFrame"])).toBe(once);
  });
});

describe("reachableSchemas", () => {
  it("should include the roots and everything they reference", () => {
    expect(reachableSchemas(registry, ["Wrapped"])).toEqual([
      "Id",
      "Role",
      "Message",
      "Ok",
      "Wrapped",
    ]);
  });

  it("should not include unrelated schemas", () => {
    expect(reachableSchemas(registry, ["Role"])).toEqual(["Role"]);
  });

  it("should throw on a dangling reference rather than emitting a broken bundle", () => {
    expect(() => reachableSchemas({ A: { $ref: "#/components/schemas/Missing" } }, ["A"])).toThrow(
      /Missing/,
    );
  });
});
