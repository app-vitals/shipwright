/**
 * metrics/src/cache.test.ts
 * Tests for in-memory TTL cache and cache key builder.
 */

import { describe, expect, it } from "bun:test";
import { Cache, buildCacheKey } from "./cache.ts";

describe("Cache", () => {
  describe("get / set", () => {
    it("returns undefined on cache miss", () => {
      const cache = new Cache<string>();
      expect(cache.get("missing")).toBeUndefined();
    });

    it("returns value on cache hit within TTL", () => {
      const cache = new Cache<string>();
      cache.set("key1", "value1", 5000);
      expect(cache.get("key1")).toBe("value1");
    });

    it("returns undefined after TTL expiry", async () => {
      const cache = new Cache<string>();
      cache.set("key1", "value1", 10); // 10ms TTL

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(cache.get("key1")).toBeUndefined();
    });

    it("evicts expired entry from store on access", async () => {
      const cache = new Cache<string>();
      cache.set("key1", "value1", 10);

      await new Promise((resolve) => setTimeout(resolve, 20));

      cache.get("key1"); // triggers eviction
      expect(cache.size()).toBe(0);
    });

    it("stores complex objects", () => {
      const cache = new Cache<{ columns: string[]; results: unknown[][] }>();
      const value = { columns: ["a", "b"], results: [[1, 2]] };
      cache.set("key1", value, 5000);
      expect(cache.get("key1")).toEqual(value);
    });

    it("overwrites existing entry on set", () => {
      const cache = new Cache<string>();
      cache.set("key1", "original", 5000);
      cache.set("key1", "updated", 5000);
      expect(cache.get("key1")).toBe("updated");
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      const cache = new Cache<string>();
      cache.set("a", "1", 5000);
      cache.set("b", "2", 5000);
      cache.set("c", "3", 5000);

      cache.clear();

      expect(cache.size()).toBe(0);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBeUndefined();
    });

    it("clear on empty cache is a no-op", () => {
      const cache = new Cache<string>();
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe("size", () => {
    it("reports 0 for empty cache", () => {
      expect(new Cache().size()).toBe(0);
    });

    it("increments on set", () => {
      const cache = new Cache<number>();
      cache.set("a", 1, 5000);
      cache.set("b", 2, 5000);
      expect(cache.size()).toBe(2);
    });

    it("does not decrement on expired entry until accessed", async () => {
      const cache = new Cache<string>();
      cache.set("x", "v", 10);

      await new Promise((resolve) => setTimeout(resolve, 20));

      // size() reflects internal store, not logical live entries
      expect(cache.size()).toBe(1);
      cache.get("x"); // evicts
      expect(cache.size()).toBe(0);
    });
  });
});

describe("buildCacheKey", () => {
  it("returns a 64-char hex SHA-256 string", async () => {
    const key = await buildCacheKey("SELECT 1");
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it("same inputs produce same key", async () => {
    const k1 = await buildCacheKey("SELECT 1", "2026-01-01", "2026-01-31");
    const k2 = await buildCacheKey("SELECT 1", "2026-01-01", "2026-01-31");
    expect(k1).toBe(k2);
  });

  it("different queries produce different keys", async () => {
    const k1 = await buildCacheKey("SELECT 1");
    const k2 = await buildCacheKey("SELECT 2");
    expect(k1).not.toBe(k2);
  });

  it("different date ranges produce different keys", async () => {
    const k1 = await buildCacheKey("SELECT 1", "2026-01-01");
    const k2 = await buildCacheKey("SELECT 1", "2026-02-01");
    expect(k1).not.toBe(k2);
  });

  it("undefined date parts are handled", async () => {
    const k1 = await buildCacheKey("SELECT 1");
    const k2 = await buildCacheKey("SELECT 1", undefined, undefined);
    expect(k1).toBe(k2);
  });
});
