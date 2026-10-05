import { describe, expect, test } from "bun:test";
import { validateOwner } from "./gh-token-files.ts";

describe("validateOwner", () => {
  test("lowercases valid owners", () => {
    expect(validateOwner("App-Vitals")).toBe("app-vitals");
    expect(validateOwner("a")).toBe("a");
  });
  test.each(["../x", "a/b", "", "-a", "a-", "a--b", "a.b", "x".repeat(40), "a\0b"])(
    "rejects %p",
    (bad) => {
      expect(() => validateOwner(bad)).toThrow();
    },
  );
});
