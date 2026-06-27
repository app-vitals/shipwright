/**
 * task-store/src/doc-store.unit.test.ts
 *
 * Unit tests for the ephemeral HTML document store. TTL expiry is driven by an
 * injected mutable clock — no real wall-clock — per the test-isolation rule.
 */

import { describe, expect, it } from "bun:test";
import type { Clock } from "./clock.ts";
import {
  DEFAULT_DOC_TTL_SECONDS,
  EphemeralDocStore,
  resolveDocTtlSeconds,
} from "./doc-store.ts";
import { PayloadTooLargeError } from "./errors.ts";

/** A clock whose time can be advanced by the test. */
function mutableClock(startMs = 0): {
  clock: Clock;
  advance(ms: number): void;
} {
  let nowMs = startMs;
  return {
    clock: { now: () => new Date(nowMs) },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

const HTML = "<!doctype html><h1>hello</h1>";

describe("EphemeralDocStore", () => {
  it("stores and retrieves a document by id", () => {
    const { clock } = mutableClock();
    const store = new EphemeralDocStore({ clock, ttlSeconds: 60 });

    const { id } = store.put(HTML);
    expect(store.get(id)).toBe(HTML);
  });

  it("returns undefined for an unknown id", () => {
    const { clock } = mutableClock();
    const store = new EphemeralDocStore({ clock });
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("returns the document right up to the expiry boundary", () => {
    const { clock, advance } = mutableClock();
    const store = new EphemeralDocStore({ clock, ttlSeconds: 10 });
    const { id } = store.put(HTML);

    // At exactly ttl (10_000ms) the doc is still alive (expiry is strictly >).
    advance(10_000);
    expect(store.get(id)).toBe(HTML);
  });

  it("expires the document once the clock passes the TTL", () => {
    const { clock, advance } = mutableClock();
    const store = new EphemeralDocStore({ clock, ttlSeconds: 10 });
    const { id } = store.put(HTML);

    advance(10_001);
    expect(store.get(id)).toBeUndefined();
    // A second get still returns undefined (entry was evicted, no crash).
    expect(store.get(id)).toBeUndefined();
  });

  it("computes expiresAt from the injected clock, not wall time", () => {
    const { clock } = mutableClock(1_000_000);
    const store = new EphemeralDocStore({ clock, ttlSeconds: 30 });
    const { expiresAt } = store.put(HTML);
    expect(expiresAt).toBe(1_000_000 + 30_000);
  });

  it("generates distinct ids for each stored document", () => {
    const { clock } = mutableClock();
    const store = new EphemeralDocStore({ clock });
    const a = store.put(HTML);
    const b = store.put(HTML);
    expect(a.id).not.toBe(b.id);
  });

  it("throws PayloadTooLargeError when the body exceeds maxBytes", () => {
    const { clock } = mutableClock();
    const store = new EphemeralDocStore({ clock, maxBytes: 8 });
    expect(() => store.put("123456789")).toThrow(PayloadTooLargeError);
  });

  it("accepts a body exactly at the maxBytes boundary", () => {
    const { clock } = mutableClock();
    const store = new EphemeralDocStore({ clock, maxBytes: 5 });
    expect(() => store.put("12345")).not.toThrow();
  });

  it("falls back to the default TTL for non-positive ttlSeconds", () => {
    const { clock } = mutableClock();
    expect(new EphemeralDocStore({ clock, ttlSeconds: 0 }).ttlSeconds).toBe(
      DEFAULT_DOC_TTL_SECONDS,
    );
    expect(new EphemeralDocStore({ clock, ttlSeconds: -5 }).ttlSeconds).toBe(
      DEFAULT_DOC_TTL_SECONDS,
    );
  });
});

describe("resolveDocTtlSeconds", () => {
  it("returns the default for unset or empty input", () => {
    expect(resolveDocTtlSeconds(undefined)).toBe(DEFAULT_DOC_TTL_SECONDS);
    expect(resolveDocTtlSeconds("")).toBe(DEFAULT_DOC_TTL_SECONDS);
    expect(resolveDocTtlSeconds("   ")).toBe(DEFAULT_DOC_TTL_SECONDS);
  });

  it("parses a valid positive integer", () => {
    expect(resolveDocTtlSeconds("120")).toBe(120);
  });

  it("falls back to the default for non-numeric or non-positive input", () => {
    expect(resolveDocTtlSeconds("abc")).toBe(DEFAULT_DOC_TTL_SECONDS);
    expect(resolveDocTtlSeconds("0")).toBe(DEFAULT_DOC_TTL_SECONDS);
    expect(resolveDocTtlSeconds("-30")).toBe(DEFAULT_DOC_TTL_SECONDS);
  });
});
