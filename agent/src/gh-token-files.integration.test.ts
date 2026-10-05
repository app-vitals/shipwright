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
import { writeFileAtomic, writeTokenFiles } from "./gh-token-files.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gh-token-files-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("writeTokenFiles", () => {
  test("single installation writes only gh-token", () => {
    writeTokenFiles(home, { defaultToken: "t1", ownerTokens: { Acme: "t1" } });
    expect(readFileSync(join(home, "gh-token"), "utf8")).toBe("t1");
    expect(existsSync(join(home, "gh-token.d"))).toBe(false);
    expect(readdirSync(home)).toEqual(["gh-token"]);
  });

  test("files are mode 0600", () => {
    writeTokenFiles(home, { defaultToken: "t1" });
    expect(statSync(join(home, "gh-token")).mode & 0o777).toBe(0o600);
    writeTokenFiles(home, { defaultToken: "t2" }); // overwrite keeps mode
    expect(statSync(join(home, "gh-token")).mode & 0o777).toBe(0o600);
  });

  test("multiple installations write lowercase per-owner files", () => {
    writeTokenFiles(home, {
      defaultToken: "a",
      ownerTokens: { Acme: "a", Other: "b" },
    });
    expect(readFileSync(join(home, "gh-token.d", "acme"), "utf8")).toBe("a");
    expect(readFileSync(join(home, "gh-token.d", "other"), "utf8")).toBe("b");
    expect(statSync(join(home, "gh-token.d", "other")).mode & 0o777).toBe(0o600);
  });

  test("stale per-owner files are removed, then the directory", () => {
    writeTokenFiles(home, {
      defaultToken: "a",
      ownerTokens: { acme: "a", other: "b", third: "c" },
    });
    writeTokenFiles(home, { defaultToken: "a", ownerTokens: { acme: "a", other: "b" } });
    expect(readdirSync(join(home, "gh-token.d")).sort()).toEqual(["acme", "other"]);
    writeTokenFiles(home, { defaultToken: "a", ownerTokens: { acme: "a" } });
    expect(existsSync(join(home, "gh-token.d"))).toBe(false);
  });

  test("path-traversal owner is rejected before anything is written", () => {
    expect(() =>
      writeTokenFiles(home, { defaultToken: "a", ownerTokens: { "../x": "a", ok: "b" } }),
    ).toThrow();
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("writeFileAtomic", () => {
  test("leaves no temp files and never exposes a torn file under racing writers", async () => {
    const path = join(home, "gh-token");
    const values = ["a".repeat(4096), "b".repeat(4096)];
    writeFileAtomic(path, values[0]);
    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        writeFileAtomic(path, values[i % 2]);
        expect(values).toContain(readFileSync(path, "utf8"));
      }),
    );
    expect(readdirSync(home)).toEqual(["gh-token"]);
  });
});
