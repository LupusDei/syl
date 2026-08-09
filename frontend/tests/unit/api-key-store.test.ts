import { describe, expect, it } from "vitest";

import { API_KEY_STORAGE_KEY, clearApiKey, readApiKey, writeApiKey } from "../../src/auth/api-key-store";
import { createMemoryStorage } from "../../src/storage";

describe("readApiKey", () => {
  it("should return the stored key when one was written", () => {
    const storage = createMemoryStorage();
    writeApiKey(storage, "sk-syl-abc");
    expect(readApiKey(storage)).toBe("sk-syl-abc");
  });

  it("should return null when nothing was ever stored", () => {
    expect(readApiKey(createMemoryStorage())).toBeNull();
  });

  it("should treat a whitespace-only stored value as absent", () => {
    const storage = createMemoryStorage();
    storage.setItem(API_KEY_STORAGE_KEY, "   ");
    expect(readApiKey(storage)).toBeNull();
  });
});

describe("writeApiKey", () => {
  it("should store the key under the documented storage key", () => {
    const storage = createMemoryStorage();
    writeApiKey(storage, "sk-syl-abc");
    expect(storage.getItem(API_KEY_STORAGE_KEY)).toBe("sk-syl-abc");
  });

  it("should trim surrounding whitespace, which is what pasting produces", () => {
    const storage = createMemoryStorage();
    writeApiKey(storage, "  sk-syl-abc\n");
    expect(readApiKey(storage)).toBe("sk-syl-abc");
  });

  it("should reject a blank key rather than store an unusable credential", () => {
    expect(() => writeApiKey(createMemoryStorage(), "   ")).toThrow(/blank/i);
  });
});

describe("clearApiKey", () => {
  it("should remove a stored key", () => {
    const storage = createMemoryStorage();
    writeApiKey(storage, "sk-syl-abc");
    clearApiKey(storage);
    expect(readApiKey(storage)).toBeNull();
  });

  it("should be a no-op when no key is stored", () => {
    const storage = createMemoryStorage();
    expect(() => clearApiKey(storage)).not.toThrow();
    expect(readApiKey(storage)).toBeNull();
  });
});
