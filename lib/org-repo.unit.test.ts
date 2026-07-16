import { describe, expect, test } from "bun:test";
import { isOrgRepo } from "./org-repo.ts";

describe("isOrgRepo — valid strings", () => {
  test("returns true for a simple org/repo string", () => {
    expect(isOrgRepo("app-vitals/shipwright")).toBe(true);
  });

  test("returns true when org and repo contain hyphens and numbers", () => {
    expect(isOrgRepo("my-org-1/my-repo-2")).toBe(true);
  });
});

describe("isOrgRepo — invalid strings", () => {
  test("returns false for a string with no slash", () => {
    expect(isOrgRepo("shipwright")).toBe(false);
  });

  test("returns false for a string with more than one slash", () => {
    expect(isOrgRepo("app-vitals/shipwright/extra")).toBe(false);
  });

  test("returns false when the org part is empty", () => {
    expect(isOrgRepo("/shipwright")).toBe(false);
  });

  test("returns false when the repo part is empty", () => {
    expect(isOrgRepo("app-vitals/")).toBe(false);
  });

  test("returns false when the org part is only whitespace", () => {
    expect(isOrgRepo("   /shipwright")).toBe(false);
  });

  test("returns false when the repo part is only whitespace", () => {
    expect(isOrgRepo("app-vitals/   ")).toBe(false);
  });

  test("returns false for an empty string", () => {
    expect(isOrgRepo("")).toBe(false);
  });
});
