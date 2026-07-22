/**
 * Regression guard for the stale hardcoded version claim (MMA-1.2).
 *
 * README.md's "Project status" section once stated "...all ship with
 * v0.1.0" — a version that drifted immediately since the release badge at
 * the top of the file already pulls the live version from GitHub releases.
 * No other test layer covers static markdown copy, so this content test is
 * the only thing that would catch a future editor re-hardcoding a version.
 *
 * Content-assertion only: readFileSync, no I/O beyond a local file read.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, ".");

function projectStatusSection(): string {
  const content = readFileSync(join(repoRoot, "README.md"), "utf8");
  const start = content.indexOf("## Project status");
  if (start === -1) {
    throw new Error("README.md is missing a '## Project status' section");
  }
  const nextHeading = content.indexOf("\n## ", start + 1);
  return nextHeading === -1 ? content.slice(start) : content.slice(start, nextHeading);
}

describe("README.md Project status section", () => {
  it("does not hardcode a bare version literal", () => {
    const section = projectStatusSection();
    expect(section).not.toMatch(/\bv0\.\d+(\.\d+)?\b/);
  });

  it("still communicates that the plugin, metrics dashboard, and agent ship together", () => {
    const section = projectStatusSection();
    expect(section).toMatch(/plugin/i);
    expect(section).toMatch(/metrics dashboard/i);
    expect(section).toMatch(/shipwright agent/i);
  });
});
