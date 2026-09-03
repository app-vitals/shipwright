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
  // Regression coverage for AAL-2.3: the live config-bundle API has been
  // observed returning authorAllowlist: null in production (Sentry issue
  // 7633628941), even though AgentConfigResponse types it as a non-nullable
  // string[]. syncConfig() must default this to [] before handing it to
  // reviewAuthorAllowlistRef.set(), so downstream .length checks never throw.
  it("defaults a null authorAllowlist (as returned by the live config-bundle API) to [] when reviewAuthorAllowlist is also absent", () => {
    const bundle = {
      authorAllowlist: null,
      reviewAuthorAllowlist: undefined,
    } as unknown as {
      authorAllowlist: string[];
      reviewAuthorAllowlist: string[];
    };

    expect(
      resolveReviewAuthorAllowlist(
        bundle.reviewAuthorAllowlist,
        bundle.authorAllowlist,
      ),
    ).toEqual([]);
  });

  it("defaults to [] when both fields are undefined", () => {
    expect(resolveReviewAuthorAllowlist(undefined, undefined)).toEqual([]);
  });

  it("syncing a null authorAllowlist into the ref does not throw and leaves get() as []", () => {
    const ref = createReviewAuthorAllowlistRef();
    const bundle = {
      authorAllowlist: null,
      reviewAuthorAllowlist: undefined,
    } as unknown as {
      authorAllowlist: string[];
      reviewAuthorAllowlist: string[];
    };

    expect(() =>
      ref.set(
        resolveReviewAuthorAllowlist(
          bundle.reviewAuthorAllowlist,
          bundle.authorAllowlist,
        ),
      ),
    ).not.toThrow();
    expect(ref.get()).toEqual([]);
    expect(ref.get().length).toBe(0);
  });

  it("passes through a real authorAllowlist array unchanged when reviewAuthorAllowlist is absent (no behavior change for real values)", () => {
    const real = ["alice", "bob"];
    expect(resolveReviewAuthorAllowlist(undefined, real)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("passes through an already-empty authorAllowlist array unchanged when reviewAuthorAllowlist is absent", () => {
    expect(resolveReviewAuthorAllowlist(undefined, [])).toEqual([]);
  });

  // DBR-2.3: reviewAuthorAllowlist is preferred over authorAllowlist, falling
  // back to authorAllowlist only when reviewAuthorAllowlist is absent
  // (null/undefined) — safe to deploy before or after DBR-2.1's admin API
  // rollout.
  it("uses reviewAuthorAllowlist when present and non-empty, ignoring authorAllowlist", () => {
    expect(
      resolveReviewAuthorAllowlist(["carol"], ["alice", "bob"]),
    ).toEqual(["carol"]);
  });

  it("uses reviewAuthorAllowlist when present but empty — an explicit [] is not treated as absent", () => {
    expect(resolveReviewAuthorAllowlist([], ["alice", "bob"])).toEqual([]);
  });

  it("falls back to authorAllowlist when reviewAuthorAllowlist is null (older admin API)", () => {
    expect(resolveReviewAuthorAllowlist(null, ["alice", "bob"])).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("falls back to authorAllowlist when reviewAuthorAllowlist is undefined (older admin API)", () => {
    expect(
      resolveReviewAuthorAllowlist(undefined, ["alice", "bob"]),
    ).toEqual(["alice", "bob"]);
  });

  it("resolves to [] when reviewAuthorAllowlist is absent and authorAllowlist is also absent", () => {
    expect(resolveReviewAuthorAllowlist(undefined, null)).toEqual([]);
    expect(resolveReviewAuthorAllowlist(null, undefined)).toEqual([]);
  });
});
