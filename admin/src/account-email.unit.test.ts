/**
 * admin/src/account-email.unit.test.ts
 * Unit tests for normalizeEmail (admin/src/account-email.ts).
 */

import { describe, expect, it } from "bun:test";
import { normalizeEmail } from "./account-email.ts";

describe("normalizeEmail", () => {
  it("lowercases", () => {
    expect(normalizeEmail("Dan@Example.COM")).toBe("dan@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  a@b.co \n")).toBe("a@b.co");
  });

  it("is idempotent", () => {
    expect(normalizeEmail(normalizeEmail("X@Y.Z"))).toBe("x@y.z");
  });
});
