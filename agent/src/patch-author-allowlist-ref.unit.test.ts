/**
 * agent/src/patch-author-allowlist-ref.unit.test.ts
 *
 * Unit tests for createPatchAuthorAllowlistRef() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  createPatchAuthorAllowlistRef,
  patchAuthorAllowlistRef,
  resolvePatchAuthorAllowlist,
} from "./patch-author-allowlist-ref.ts";

describe("createPatchAuthorAllowlistRef", () => {
  it("initial get() before any set() returns an empty/safe default", () => {
    const ref = createPatchAuthorAllowlistRef();
    expect(ref.get()).toEqual([]);
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createPatchAuthorAllowlistRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to an empty list", () => {
    const ref = createPatchAuthorAllowlistRef();
    ref.set([]);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toEqual([]);
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createPatchAuthorAllowlistRef();
    ref.set(["alice"]);
    expect(ref.hasSynced()).toBe(true);

    ref.set([]);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set allowlist regardless of how many times set() was called", () => {
    const ref = createPatchAuthorAllowlistRef();
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
    const refA = createPatchAuthorAllowlistRef();
    const refB = createPatchAuthorAllowlistRef();

    refA.set(["alice"]);

    expect(refA.get()).toEqual(["alice"]);
    expect(refB.get()).toEqual([]);
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });

  it("set() with an empty array is reflected by the next get()", () => {
    const ref = createPatchAuthorAllowlistRef();
    ref.set(["alice"]);
    expect(ref.get()).toHaveLength(1);

    ref.set([]);
    expect(ref.get()).toEqual([]);
  });
});

describe("patchAuthorAllowlistRef (process-wide singleton)", () => {
  it("is a working ref that reflects set() through get(), independent of createPatchAuthorAllowlistRef() instances", () => {
    const independent = createPatchAuthorAllowlistRef();
    independent.set(["should-not-leak"]);

    patchAuthorAllowlistRef.set(["alice"]);
    expect(patchAuthorAllowlistRef.get()).toEqual(["alice"]);
    expect(independent.get()).toEqual(["should-not-leak"]);
  });
});

describe("resolvePatchAuthorAllowlist", () => {
  // patchAuthorAllowlist (DBR-1.1) is a brand new column with no legacy
  // predecessor, so resolvePatchAuthorAllowlist takes a single field and
  // just needs to default a nullish value to [] before it's handed to
  // patchAuthorAllowlistRef.set(), mirroring the null-safety of
  // resolveReviewAuthorAllowlist without a legacy-field fallback.
  it("defaults null to []", () => {
    expect(resolvePatchAuthorAllowlist(null)).toEqual([]);
  });

  it("defaults undefined to []", () => {
    expect(resolvePatchAuthorAllowlist(undefined)).toEqual([]);
  });

  it("passes through an already-empty array unchanged", () => {
    expect(resolvePatchAuthorAllowlist([])).toEqual([]);
  });

  it("passes through a real array unchanged", () => {
    expect(resolvePatchAuthorAllowlist(["alice", "bob"])).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("syncing a null patchAuthorAllowlist into the ref does not throw and leaves get() as []", () => {
    const ref = createPatchAuthorAllowlistRef();
    const bundle = { patchAuthorAllowlist: null } as unknown as {
      patchAuthorAllowlist: string[];
    };

    expect(() =>
      ref.set(resolvePatchAuthorAllowlist(bundle.patchAuthorAllowlist)),
    ).not.toThrow();
    expect(ref.get()).toEqual([]);
    expect(ref.get().length).toBe(0);
  });
});
