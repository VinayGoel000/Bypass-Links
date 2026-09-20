import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryCache } from "../utils/cache.js";

describe("MemoryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores and retrieves values", () => {
    const cache = new MemoryCache<string>(60);
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("returns undefined for missing keys", () => {
    const cache = new MemoryCache<string>(60);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("expires entries after TTL", () => {
    const cache = new MemoryCache<string>(10);
    cache.set("key1", "value1");

    vi.advanceTimersByTime(11_000);

    expect(cache.get("key1")).toBeUndefined();
  });

  it("checks existence", () => {
    const cache = new MemoryCache<string>(60);
    cache.set("key1", "value1");
    expect(cache.has("key1")).toBe(true);
    expect(cache.has("key2")).toBe(false);
  });

  it("deletes entries", () => {
    const cache = new MemoryCache<string>(60);
    cache.set("key1", "value1");
    cache.delete("key1");
    expect(cache.get("key1")).toBeUndefined();
  });

  it("clears all entries", () => {
    const cache = new MemoryCache<string>(60);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
