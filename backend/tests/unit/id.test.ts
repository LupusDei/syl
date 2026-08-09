import { describe, expect, it } from "vitest";

import { fixedClock } from "../../src/services/clock.js";
import { createUuidV7, idType, isId, newId, uuidv7 } from "../../src/services/id.js";

/** Entropy that is anything but random, so every other field is assertable. */
const zeroEntropy = (into: Uint8Array): void => {
  into.fill(0);
};

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("createUuidV7", () => {
  it("should produce a canonical UUID with version 7 and the RFC variant", () => {
    const generate = createUuidV7(fixedClock(Date.UTC(2026, 7, 9)), zeroEntropy);

    const id = generate();

    expect(id).toMatch(CANONICAL);
    expect(id[14]).toBe("7");
    // Variant bits `10` — the first hex digit of group four is 8, 9, a or b.
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("should encode the clock in the leading 48 bits, so ids sort by time", () => {
    const epochMs = Date.UTC(2026, 7, 9, 7, 0, 3, 114);
    const generate = createUuidV7(fixedClock(epochMs), zeroEntropy);

    const id = generate();
    const timestampHex = id.slice(0, 8) + id.slice(9, 13);

    expect(Number.parseInt(timestampHex, 16)).toBe(epochMs);
  });

  it("should sort in mint order across milliseconds", () => {
    let now = Date.UTC(2026, 7, 9);
    const generate = createUuidV7(() => now, zeroEntropy);

    const ids = [generate(), (now += 1, generate()), (now += 1, generate())];

    expect([...ids].sort()).toEqual(ids);
  });

  it("should still sort in mint order inside a single millisecond", () => {
    // Left purely random, ids minted in the same millisecond sort arbitrarily.
    // That is invisible until a cursor built from an id starts skipping or
    // repeating a row.
    const generate = createUuidV7(fixedClock(Date.UTC(2026, 7, 9)), zeroEntropy);

    const ids = Array.from({ length: 50 }, generate);

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it("should keep sorting forwards when the clock steps backwards", () => {
    // An NTP correction must not produce an id that sorts before its
    // predecessor. Time can move back; the sequence cannot.
    let now = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
    const generate = createUuidV7(() => now, zeroEntropy);

    const before = generate();
    now -= 60_000;
    const after = generate();

    expect(after > before).toBe(true);
  });

  it("should not repeat itself when more than 4096 ids are minted in one millisecond", () => {
    const generate = createUuidV7(fixedClock(Date.UTC(2026, 7, 9)), zeroEntropy);

    const ids = Array.from({ length: 5_000 }, generate);

    expect(new Set(ids).size).toBe(5_000);
    expect([...ids].sort()).toEqual(ids);
  });

  it("should use its entropy for the trailing bits", () => {
    const ones = (into: Uint8Array): void => {
      into.fill(0xff);
    };
    const generate = createUuidV7(fixedClock(Date.UTC(2026, 7, 9)), ones);

    expect(generate().slice(24)).toBe("ffffffffffff");
  });
});

describe("uuidv7", () => {
  it("should be unique across rapid calls on the real clock and entropy", () => {
    const ids = Array.from({ length: 1_000 }, uuidv7);

    expect(new Set(ids).size).toBe(1_000);
  });
});

describe("newId", () => {
  it("should prefix the type, so a dangling reference is legible in a log line", () => {
    const id = newId("message", () => "0198f2c0-0001-7000-8000-00000000b001");

    expect(id).toBe("syl:message:0198f2c0-0001-7000-8000-00000000b001");
  });

  it("should mint a real id when given no generator", () => {
    expect(isId(newId("todo"), "todo")).toBe(true);
  });
});

describe("isId", () => {
  it("should accept an id of the expected type", () => {
    expect(isId("syl:conversation:00000000-0000-7000-8000-000000000001", "conversation")).toBe(
      true,
    );
  });

  it("should reject an id of a different type, which is the reference-swap bug", () => {
    expect(isId("syl:todo:00000000-0000-7000-8000-000000000001", "reminder")).toBe(false);
  });

  it("should accept any type when none is named", () => {
    expect(isId("syl:goal:00000000-0000-7000-8000-000000000001")).toBe(true);
  });

  it("should reject a bare uuid with no namespace", () => {
    expect(isId("00000000-0000-7000-8000-000000000001")).toBe(false);
  });

  it("should accept an uppercase uuid, because the contract's pattern does", () => {
    // Being stricter than the contract at an API boundary means rejecting
    // requests a conforming client is entitled to make.
    expect(isId("syl:goal:00000000-0000-7000-8000-00000000000A")).toBe(true);
  });

  it("should mint lowercase, whatever it is willing to accept", () => {
    const id = newId("goal");

    expect(id).toBe(id.toLowerCase());
  });

  it("should reject something that is not an id at all", () => {
    expect(isId("../../etc/passwd")).toBe(false);
  });
});

describe("idType", () => {
  it("should name the type segment", () => {
    expect(idType("syl:delivery:00000000-0000-7000-8000-000000000001")).toBe("delivery");
  });

  it("should be null for a non-id", () => {
    expect(idType("nonsense")).toBeNull();
  });
});

describe("the memory and dream id types", () => {
  // syl-5yt. The union is meant to be the closed list, and for a while it was
  // not: 0012 and 0013 shipped ids the union had never heard of. The shared
  // regex accepted them, so nothing failed — which is exactly why this is
  // worth pinning rather than trusting.
  it.each(["memory_node", "memory_edge", "dream_session"] as const)(
    "should mint and recognise a %s id",
    (type) => {
      const id = newId(type);

      expect(idType(id)).toBe(type);
      expect(isId(id, type)).toBe(true);
    },
  );

  it("should keep the graph and the dream log in separate id namespaces", () => {
    // Constraint 7. The dream log is telemetry ABOUT the graph and never a node
    // in it. If these two ever collided, a dream session could be addressed as
    // a memory node and the next sweep would consolidate Syl's own dreams as
    // experience.
    const node = newId("memory_node");

    expect(isId(node, "dream_session")).toBe(false);
    expect(isId(newId("dream_session"), "memory_node")).toBe(false);
  });

  it("should not address a memory node with an operational goal id", () => {
    // The node KIND is a column, not part of the id: `syl:goal:<uuid>` already
    // addresses a row in the operational goals table, and one id shape must
    // never address two different stores.
    expect(isId(newId("goal"), "memory_node")).toBe(false);
  });
});
