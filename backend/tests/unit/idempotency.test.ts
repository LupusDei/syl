import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SylDatabase } from "../../src/services/database.js";
import {
  IDEMPOTENCY_RETENTION_MS,
  IdempotencyConflict,
  IdempotencyStore,
  fingerprintOf,
  stableStringify,
} from "../../src/services/idempotency.js";
import { TEST_NOW, testDatabase } from "../helpers/service.js";

describe("stableStringify", () => {
  it("should be insensitive to key order", () => {
    // A client that rebuilds its JSON between retries may reorder fields. A
    // 409 for that would be technically defensible and practically hostile.
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("should still distinguish different values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("should handle primitives, nulls and nesting", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(7)).toBe("7");
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify({ a: { d: 1, c: [{ f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[{"e":2,"f":1}],"d":1}}',
    );
  });

  it("should drop undefined fields, which JSON has no spelling for", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("fingerprintOf", () => {
  it("should separate the same body on different endpoints", () => {
    expect(fingerprintOf("POST", "/devices", { a: 1 })).not.toBe(
      fingerprintOf("POST", "/reminders", { a: 1 }),
    );
  });

  it("should separate different methods on the same path", () => {
    expect(fingerprintOf("POST", "/x", {})).not.toBe(fingerprintOf("DELETE", "/x", {}));
  });

  it("should match a byte-identical retry", () => {
    expect(fingerprintOf("POST", "/devices", { a: 1 })).toBe(
      fingerprintOf("post", "/devices", { a: 1 }),
    );
  });
});

describe("IdempotencyStore", () => {
  let db: SylDatabase;
  let now = TEST_NOW;
  let store: IdempotencyStore;

  beforeEach(() => {
    db = testDatabase();
    now = TEST_NOW;
    store = new IdempotencyStore({ db: db.handle, clock: () => now });
  });

  afterEach(() => {
    db.close();
  });

  it("should report a key it has never seen", () => {
    expect(store.lookup("k1", fingerprintOf("POST", "/devices", {}))).toBeNull();
  });

  it("should replay a stored response for the same request", () => {
    const fingerprint = fingerprintOf("POST", "/devices", { token: "a" });
    store.save("k1", fingerprint, 201, { id: "syl:device:x" });

    expect(store.lookup("k1", fingerprint)).toEqual({ status: 201, body: { id: "syl:device:x" } });
  });

  it("should refuse the same key used for a different request", () => {
    store.save("k1", fingerprintOf("POST", "/devices", { token: "a" }), 201, { id: "x" });

    expect(() => store.lookup("k1", fingerprintOf("POST", "/devices", { token: "b" }))).toThrow(
      IdempotencyConflict,
    );
  });

  it("should forget a key past its retention rather than calling it a conflict", () => {
    const fingerprint = fingerprintOf("POST", "/devices", { token: "a" });
    store.save("k1", fingerprint, 201, { id: "x" });

    now += IDEMPOTENCY_RETENTION_MS;
    // Not a conflict: it is a key we no longer hold. Refusing a legitimate
    // request a day later would be worse than running it again.
    expect(store.lookup("k1", fingerprintOf("POST", "/devices", { token: "b" }))).toBeNull();
  });

  it("should still honour a key inside its retention", () => {
    const fingerprint = fingerprintOf("POST", "/devices", { token: "a" });
    store.save("k1", fingerprint, 201, { id: "x" });

    now += IDEMPOTENCY_RETENTION_MS - 1;
    expect(store.lookup("k1", fingerprint)).not.toBeNull();
  });

  it("should prune expired keys and leave live ones", () => {
    store.save("old", fingerprintOf("POST", "/a", {}), 200, {});
    now += IDEMPOTENCY_RETENTION_MS;
    store.save("new", fingerprintOf("POST", "/b", {}), 200, {});

    expect(store.prune()).toBe(1);
    expect(store.lookup("new", fingerprintOf("POST", "/b", {}))).not.toBeNull();
  });

  it("should let a save overwrite in place rather than failing on the key", () => {
    const fingerprint = fingerprintOf("POST", "/a", {});
    store.save("k1", fingerprint, 200, { v: 1 });
    store.save("k1", fingerprint, 200, { v: 2 });
    expect(store.lookup("k1", fingerprint)).toEqual({ status: 200, body: { v: 2 } });
  });
});
