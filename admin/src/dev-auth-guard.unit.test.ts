/**
 * admin/src/dev-auth-guard.unit.test.ts
 *
 * Unit tests for the admin dev-auth guard predicate.
 * Pure logic over an injected env object — no process.env reads, no I/O.
 */

import { describe, expect, it } from "bun:test";
import { isDevAuthAllowed } from "./dev-auth-guard.ts";

describe("isDevAuthAllowed", () => {
  it("returns true when ADMIN_DEV_AUTH=true and NODE_ENV=development", () => {
    expect(
      isDevAuthAllowed({ ADMIN_DEV_AUTH: "true", NODE_ENV: "development" }),
    ).toBe(true);
  });

  it("returns true when ADMIN_DEV_AUTH=true and NODE_ENV is unset", () => {
    expect(isDevAuthAllowed({ ADMIN_DEV_AUTH: "true" })).toBe(true);
  });

  it("returns true when ADMIN_DEV_AUTH=true and NODE_ENV=test", () => {
    expect(
      isDevAuthAllowed({ ADMIN_DEV_AUTH: "true", NODE_ENV: "test" }),
    ).toBe(true);
  });

  it("returns false when NODE_ENV=production regardless of ADMIN_DEV_AUTH", () => {
    expect(
      isDevAuthAllowed({ ADMIN_DEV_AUTH: "true", NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("returns false in production even when ADMIN_DEV_AUTH is unset", () => {
    expect(isDevAuthAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("returns false when ADMIN_DEV_AUTH is not 'true' (non-prod)", () => {
    expect(
      isDevAuthAllowed({ ADMIN_DEV_AUTH: "false", NODE_ENV: "development" }),
    ).toBe(false);
  });

  it("returns false when ADMIN_DEV_AUTH is unset (non-prod)", () => {
    expect(isDevAuthAllowed({ NODE_ENV: "development" })).toBe(false);
  });

  it("returns false when both ADMIN_DEV_AUTH and NODE_ENV are unset", () => {
    expect(isDevAuthAllowed({})).toBe(false);
  });
});
