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

describe("README.md competitor-naming policy (brand/MESSAGING.md D10)", () => {
  const content = readFileSync(join(repoRoot, "README.md"), "utf8");

  it("does not name a competitor", () => {
    const match = content.match(/devin|cursor|openhands|augment code|copilot/i);
    expect(match?.[0] ?? null).toBeNull();
  });

  it("still has the Compare it bullet", () => {
    expect(content).toMatch(/\*\*Compare it\*\*/);
  });
});

describe("docs/quickstart.md first-PR path", () => {
  const content = readFileSync(join(repoRoot, "docs/quickstart.md"), "utf8");

  it("uses the working two-step plugin install form", () => {
    expect(content).toContain("/plugin marketplace add app-vitals/shipwright");
    expect(content).toContain("/plugin install shipwright@shipwright");
  });

  it("does not use the failing marketplace-qualified install form", () => {
    expect(content).not.toContain("shipwright@app-vitals/shipwright");
  });

  it("does not contain stale not-yet-built phrases", () => {
    expect(content).not.toMatch(/still being built|coming soon|🚧|not yet ready/i);
  });

  it("walks plan-session, dev-task and review via the local store", () => {
    expect(content).toContain("./scripts/local-store.sh");
    expect(content).toContain("/shipwright:plan-session");
    expect(content).toContain("/shipwright:dev-task");
    expect(content).toContain("/shipwright:review");
  });

  it("states the Docker prerequisite, expected time and CI coverage limits", () => {
    expect(content).toMatch(/\*\*Docker\*\*/);
    expect(content).toMatch(/## Expected time/);
    expect(content).toMatch(/## What CI does not cover/);
  });
});
