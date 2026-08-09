import { describe, expect, it, vi } from "vitest";

import { createMemoryStorage, defaultStorage, safeStorage } from "../../src/storage";

/** A Storage that throws on every operation — Safari private mode's behaviour. */
function hostileStorage(): Storage {
  const throwing = (): never => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    get length(): number {
      return throwing();
    },
    clear: throwing,
    getItem: throwing,
    key: throwing,
    removeItem: throwing,
    setItem: throwing,
  } as unknown as Storage;
}

describe("createMemoryStorage", () => {
  it("should round-trip a value when set then read", () => {
    const storage = createMemoryStorage();
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
  });

  it("should return null when the key was never written", () => {
    expect(createMemoryStorage().getItem("missing")).toBeNull();
  });

  it("should forget a key when it is removed", () => {
    const storage = createMemoryStorage();
    storage.setItem("k", "v");
    storage.removeItem("k");
    expect(storage.getItem("k")).toBeNull();
  });
});

describe("safeStorage", () => {
  it("should pass values through when the underlying storage works", () => {
    const inner = createMemoryStorage();
    const storage = safeStorage(inner);
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
    expect(inner.getItem("k")).toBe("v");
  });

  it("should fall back to memory when the source is null", () => {
    const storage = safeStorage(null);
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
  });

  it("should swallow a throwing setItem rather than crash the app", () => {
    const storage = safeStorage(hostileStorage());
    expect(() => storage.setItem("k", "v")).not.toThrow();
  });

  it("should report null rather than throw when getItem throws", () => {
    const storage = safeStorage(hostileStorage());
    expect(storage.getItem("k")).toBeNull();
  });

  it("should swallow a throwing removeItem", () => {
    const storage = safeStorage(hostileStorage());
    expect(() => storage.removeItem("k")).not.toThrow();
  });
});

describe("defaultStorage", () => {
  it("should use globalThis.localStorage when one is present", () => {
    const inner = createMemoryStorage();
    vi.stubGlobal("localStorage", inner);
    try {
      defaultStorage().setItem("k", "v");
      expect(inner.getItem("k")).toBe("v");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should return a working store when there is no localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    try {
      const storage = defaultStorage();
      storage.setItem("k", "v");
      expect(storage.getItem("k")).toBe("v");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should survive a localStorage whose getter itself throws", () => {
    // Safari in private mode throws from the property access, not from
    // setItem — so guarding only the calls is not enough.
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      const storage = defaultStorage();
      storage.setItem("k", "v");
      expect(storage.getItem("k")).toBe("v");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
