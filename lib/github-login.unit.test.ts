import { describe, expect, test } from "bun:test";
import { isGithubLogin } from "./github-login.ts";

describe("isGithubLogin — valid strings", () => {
  test("returns true for a simple login", () => {
    expect(isGithubLogin("octocat")).toBe(true);
  });

  test("returns true for a login with hyphens and numbers", () => {
    expect(isGithubLogin("my-org-1")).toBe(true);
  });

  test("returns true for a single character login", () => {
    expect(isGithubLogin("a")).toBe(true);
  });

  test("returns true for a login at the max length of 39 characters", () => {
    expect(isGithubLogin("a".repeat(39))).toBe(true);
  });
});

describe("isGithubLogin — invalid strings", () => {
  test("returns false for an empty string", () => {
    expect(isGithubLogin("")).toBe(false);
  });

  test("returns false for a login over 39 characters", () => {
    expect(isGithubLogin("a".repeat(40))).toBe(false);
  });

  test("returns false for a login with a leading hyphen", () => {
    expect(isGithubLogin("-octocat")).toBe(false);
  });

  test("returns false for a login with a trailing hyphen", () => {
    expect(isGithubLogin("octocat-")).toBe(false);
  });

  test("returns false for a login with consecutive hyphens", () => {
    expect(isGithubLogin("octo--cat")).toBe(false);
  });

  test("returns false for a login containing an underscore", () => {
    expect(isGithubLogin("octo_cat")).toBe(false);
  });

  test("returns false for a login containing a space", () => {
    expect(isGithubLogin("octo cat")).toBe(false);
  });

  test("returns false for a login containing a slash", () => {
    expect(isGithubLogin("octo/cat")).toBe(false);
  });
});
