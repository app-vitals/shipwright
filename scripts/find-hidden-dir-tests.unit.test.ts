import { describe, expect, it } from "bun:test";
import { filterHiddenDirTestFiles } from "./find-hidden-dir-tests";

describe("filterHiddenDirTestFiles", () => {
  it("keeps a test file under a hidden directory", () => {
    expect(
      filterHiddenDirTestFiles([".claude/commands/docs-sync.content.test.ts"]),
    ).toEqual([".claude/commands/docs-sync.content.test.ts"]);
  });

  it("excludes test files not under any hidden directory", () => {
    expect(
      filterHiddenDirTestFiles(["scripts/check-coverage.unit.test.ts"]),
    ).toEqual([]);
  });

  it("excludes node_modules and .git paths even though they are (or contain) dot-prefixed segments", () => {
    expect(
      filterHiddenDirTestFiles([
        "node_modules/.bin/foo.test.ts",
        ".git/hooks/pre-commit.test.ts",
      ]),
    ).toEqual([]);
  });

  it("excludes the same ignore prefixes and canary suffix bunfig.toml applies to the main walk", () => {
    expect(
      filterHiddenDirTestFiles([
        "site/.astro/generated.test.ts",
        "metrics/e2e/.cache/foo.test.ts",
        "admin/e2e/.tmp/bar.test.ts",
        ".claude/scripts/foo.canary.test.ts",
      ]),
    ).toEqual([]);
  });

  it("does not flag a dot-prefixed filename with no dot-prefixed directory segment", () => {
    expect(filterHiddenDirTestFiles(["scripts/.foo.test.ts"])).toEqual([]);
  });

  it("returns results sorted", () => {
    expect(
      filterHiddenDirTestFiles([".claude/z.test.ts", ".claude/a.test.ts"]),
    ).toEqual([".claude/a.test.ts", ".claude/z.test.ts"]);
  });

  it("returns an empty array when given no files", () => {
    expect(filterHiddenDirTestFiles([])).toEqual([]);
  });
});
