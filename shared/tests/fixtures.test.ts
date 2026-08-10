import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, fixtureEntries, fixtureNames, loadFixture } from "../src/fixtures.js";
import { FIXTURES_DIR, loadSchemas } from "../src/spec.js";
import { validate } from "../src/validate.js";

/**
 * The gate.
 *
 * Every fixture is validated against the schema the manifest claims for it.
 * This is the TypeScript half of `syl-001.2.6`; the Swift half decodes the
 * same files through `SylKit`'s models. Either side drifting fails a build.
 */

const registry = loadSchemas();

function allJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return allJsonFiles(full);
    return entry.name.endsWith(".json") ? [relative(FIXTURES_DIR, full)] : [];
  });
}

describe("the fixture manifest", () => {
  it("should list every JSON file in the fixture tree", () => {
    // Otherwise a fixture can be added, never validated, and quietly rot.
    const onDisk = allJsonFiles(FIXTURES_DIR)
      .filter((file) => file !== "manifest.json")
      .sort();
    const listed = fixtureEntries().map((entry) => entry.file).sort();
    expect(listed).toEqual(onDisk);
  });

  it("should name only schemas that exist in the contract", () => {
    const unknown = fixtureEntries()
      .filter((entry) => registry[entry.schema] === undefined)
      .map((entry) => `${entry.file} -> ${entry.schema}`);
    expect(unknown).toEqual([]);
  });

  it("should give every fixture a summary explaining why it exists", () => {
    const bare = fixtureEntries()
      .filter((entry) => entry.summary.trim().length < 10)
      .map((entry) => entry.file);
    expect(bare).toEqual([]);
  });

  it("should have unique names", () => {
    const names = fixtureNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("should cover a meaningful surface rather than a token file or two", () => {
    expect(fixtureEntries().length).toBeGreaterThan(40);
  });
});

describe("every fixture matches the contract", () => {
  for (const entry of fixtureEntries()) {
    it(`should decode ${entry.file} as ${entry.schema}`, () => {
      const { body } = loadFixture(entry.file.replace(/\.json$/, ""));

      if (entry.envelope === "ok") {
        // The file is the whole wire body. Check the envelope, then the data.
        expect(body).toMatchObject({ success: true });
        const data = (body as { data: unknown }).data;
        expect(validate(registry, entry.schema, data)).toEqual([]);
      } else {
        expect(validate(registry, entry.schema, body)).toEqual([]);
      }
    });
  }
});

describe("fixture coverage of the contract", () => {
  it("should have a fixture for every WebSocket frame type", () => {
    const covered = new Set(
      fixtureEntries()
        .filter((entry) => entry.file.startsWith("ws/"))
        .map((entry) => entry.schema),
    );
    const frames = Object.keys(registry).filter(
      (name) => name.startsWith("Ws") && !name.endsWith("Frame") && name !== "WsFrameType",
    );
    expect([...frames].filter((name) => !covered.has(name))).toEqual([]);
  });

  it("should have a fixture for every error code the contract defines", () => {
    const codes = new Set(
      fixtureEntries()
        .filter((entry) => entry.file.startsWith("errors/"))
        .map((entry) => {
          const body = fixture(entry.file.replace(/\.json$/, "")) as {
            error: { code: string };
          };
          return body.error.code;
        }),
    );
    const declared = registry["ErrorCode"]?.enum ?? [];
    const missing = declared.filter((code) => !codes.has(code as string));
    // Codes a client can actually receive must all have a fixture; the ones
    // exercised only by a write path it cannot reach yet are listed here so
    // the gap is a decision rather than an oversight.
    //
    // `FORBIDDEN` came off this list when `GET /logs` landed: it is now a
    // refusal a real client receives — the admin, holding a device-scoped key —
    // rather than a code nothing emits.
    expect(missing).toEqual(["CONFLICT", "RRULE_UNSUPPORTED", "UNKNOWN_JOB_KIND", "DEVICE_TOKEN_INVALID"]);
  });

  it("should never let a presence fixture carry a seq", () => {
    for (const entry of fixtureEntries()) {
      if (entry.schema !== "WsPresence") continue;
      const body = fixture(entry.file.replace(/\.json$/, "")) as Record<string, unknown>;
      expect(body["seq"]).toBeUndefined();
      expect(body["ttl_ms"]).toBeDefined();
    }
  });

  it("should never put a presence frame in a replay fixture", () => {
    const replay = fixture("ws/sync_response") as { frames: readonly { type: string }[] };
    expect(replay.frames.map((frame) => frame.type)).not.toContain("presence");
  });

  it("should keep every instant in UTC with a Z suffix", () => {
    // A fixed offset that reaches a fixture becomes a fixed offset in a
    // hand-written Swift model, and then survives exactly one DST boundary.
    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !value.endsWith("Z")) {
          offenders.push(`${path} = ${value}`);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    for (const entry of fixtureEntries()) {
      walk(fixture(entry.file.replace(/\.json$/, "")), entry.file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("loadFixture", () => {
  it("should return the manifest entry alongside the body", () => {
    const loaded = loadFixture("ws/presence_speaking");
    expect(loaded.schema).toBe("WsPresence");
    expect(loaded.envelope).toBe("raw");
    expect(loaded.body).toMatchObject({ type: "presence", state: "speaking", ttl_ms: 4000 });
  });

  it("should throw and list the alternatives rather than return undefined", () => {
    // A mock route serving `undefined` sends the squad building against it to
    // debug their own client first.
    expect(() => loadFixture("ws/nope")).toThrow(/No fixture named/);
    expect(() => loadFixture("ws/nope")).toThrow(/ws\/presence_speaking/);
  });
});
