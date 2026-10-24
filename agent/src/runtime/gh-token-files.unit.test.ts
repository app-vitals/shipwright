import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateOwner, writeTokenFiles } from "./gh-token-files.ts";

describe("validateOwner", () => {
  test("lowercases valid owners", () => {
    expect(validateOwner("App-Vitals")).toBe("app-vitals");
    expect(validateOwner("a")).toBe("a");
  });
  test.each([
    "../x",
    "a/b",
    "",
    "-a",
    "a-",
    "a--b",
    "a.b",
    "x".repeat(40),
    "a\0b",
  ])("rejects %p", (bad) => {
    expect(() => validateOwner(bad)).toThrow();
  });
});

describe("writeTokenFiles — single installation", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gh-token-files-unit-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("writes the lowercase owner file (0600) in a 0700 directory", () => {
    writeTokenFiles(home, { defaultToken: "t1", ownerTokens: { Acme: "t1" } });
    expect(readFileSync(join(home, "gh-token"), "utf8")).toBe("t1");
    expect(readFileSync(join(home, "gh-token.d", "acme"), "utf8")).toBe("t1");
    expect(statSync(join(home, "gh-token.d", "acme")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "gh-token.d")).mode & 0o777).toBe(0o700);
  });

  test("the directory is kept when only one installation remains; stale owners are pruned", () => {
    writeTokenFiles(home, {
      defaultToken: "a",
      ownerTokens: { acme: "a", other: "b" },
    });
    writeTokenFiles(home, { defaultToken: "a", ownerTokens: { acme: "a" } });
    expect(existsSync(join(home, "gh-token.d"))).toBe(true);
    expect(readdirSync(join(home, "gh-token.d"))).toEqual(["acme"]);
  });

  test("a default-token-only write creates no gh-token.d", () => {
    writeTokenFiles(home, { defaultToken: "t1" });
    expect(readdirSync(home)).toEqual(["gh-token"]);
  });
});
