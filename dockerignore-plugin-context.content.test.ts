/**
 * dockerignore-plugin-context.content.test.ts
 *
 * `.dockerignore` excludes `coverage` / `**\/coverage` (build output). That
 * must not drop tracked source under plugins/ (notably
 * plugins/shipwright/scripts/coverage/) from the agent image build context.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isExcluded, parseDockerignore } from "./dockerignore-context.ts";

const ROOT = import.meta.dir;

const rules = parseDockerignore(
  readFileSync(join(ROOT, ".dockerignore"), "utf8"),
);

describe(".dockerignore vs plugin build context", () => {
  it("excludes no tracked file under plugins/", () => {
    const res = Bun.spawnSync(["git", "ls-files", "plugins/"], { cwd: ROOT });
    const files = res.stdout.toString().split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => isExcluded(rules, f))).toEqual([]);
  });

  it("keeps plugins/shipwright/scripts/coverage/ in the context", () => {
    expect(
      isExcluded(rules, "plugins/shipwright/scripts/coverage/lcov.ts"),
    ).toBe(false);
  });

  it("still excludes coverage output dirs elsewhere", () => {
    expect(isExcluded(rules, "admin/coverage/x.html")).toBe(true);
    expect(isExcluded(rules, "coverage/lcov.info")).toBe(true);
    expect(isExcluded(rules, "node_modules/foo/index.js")).toBe(true);
  });
});
