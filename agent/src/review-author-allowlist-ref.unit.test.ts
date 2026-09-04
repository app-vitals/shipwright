/**
 * agent/src/review-author-allowlist-ref.unit.test.ts
 *
 * Unit tests for createReviewAuthorAllowlistRef() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  createReviewAuthorAllowlistRef,
  resolveReviewAuthorAllowlist,
  reviewAuthorAllowlistRef,
} from "./review-author-allowlist-ref.ts";

describe("createReviewAuthorAllowlistRef", () => {
  it("initial get() before any set() returns an empty/safe default", () => {
    const ref = createReviewAuthorAllowlistRef();
    expect(ref.get()).toEqual([]);
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createReviewAuthorAllowlistRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to an empty list", () => {
    const ref = createReviewAuthorAllowlistRef();
    ref.set([]);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toEqual([]);
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createReviewAuthorAllowlistRef();
    ref.set(["alice"]);
    expect(ref.hasSynced()).toBe(true);

    ref.set([]);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set allowlist regardless of how many times set() was called", () => {
    const ref = createReviewAuthorAllowlistRef();
    const first = ["alice"];
    const second = ["bob"];
    const third = ["carol", "dave"];

    ref.set(first);
    expect(ref.get()).toBe(first);

    ref.set(second);
    expect(ref.get()).toBe(second);

    ref.set(third);
    expect(ref.get()).toEqual(third);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createReviewAuthorAllowlistRef();
    const refB = createReviewAuthorAllowlistRef();

    refA.set(["alice"]);

    expect(refA.get()).toEqual(["alice"]);
    expect(refB.get()).toEqual([]);
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });

  it("set() with an empty array is reflected by the next get()", () => {
    const ref = createReviewAuthorAllowlistRef();
    ref.set(["alice"]);
    expect(ref.get()).toHaveLength(1);

    ref.set([]);
    expect(ref.get()).toEqual([]);
  });
});

describe("reviewAuthorAllowlistRef (process-wide singleton)", () => {
  it("is a working ref that reflects set() through get(), independent of createReviewAuthorAllowlistRef() instances", () => {
    const independent = createReviewAuthorAllowlistRef();
    independent.set(["should-not-leak"]);

    reviewAuthorAllowlistRef.set(["alice"]);
    expect(reviewAuthorAllowlistRef.get()).toEqual(["alice"]);
    expect(independent.get()).toEqual(["should-not-leak"]);
  });
});

describe("resolveReviewAuthorAllowlist", () => {
  // Regression coverage for AAL-2.3 / DBR-2.4: the live config-bundle API
  // has been observed returning a nullish reviewAuthorAllowlist in
  // production (Sentry issue 7633628941), even though AgentConfigResponse
  // types it as a non-nullable string[]. syncConfig() must default this to
  // [] before handing it to reviewAuthorAllowlistRef.set(), so downstream
  // .length checks never throw.
  it("defaults a null reviewAuthorAllowlist to []", () => {
    expect(resolveReviewAuthorAllowlist(null)).toEqual([]);
  });

  it("defaults an undefined reviewAuthorAllowlist to []", () => {
    expect(resolveReviewAuthorAllowlist(undefined)).toEqual([]);
  });

  it("syncing a null reviewAuthorAllowlist into the ref does not throw and leaves get() as []", () => {
    const ref = createReviewAuthorAllowlistRef();

    expect(() => ref.set(resolveReviewAuthorAllowlist(null))).not.toThrow();
    expect(ref.get()).toEqual([]);
    expect(ref.get().length).toBe(0);
  });

  it("passes through a real reviewAuthorAllowlist array unchanged", () => {
    expect(resolveReviewAuthorAllowlist(["alice", "bob"])).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("passes through an already-empty reviewAuthorAllowlist array unchanged", () => {
    expect(resolveReviewAuthorAllowlist([])).toEqual([]);
  });
});
