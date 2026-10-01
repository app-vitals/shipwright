/**
 * research-docs.md content tests — Step A0 config-driven fallback.
 *
 * Step A0's manual-invocation fallback previously instructed a raw shell
 * for-loop over every directory under repos/ as its repo-list source.
 * RSF-2.3 replaced that with resolveScopedRepos() (RSF-2.1), the same
 * config-driven resolver the check-docs-freshness.ts precheck itself
 * resolves against (RSF-2.2) to produce the priority-1 list.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RESEARCH_DOCS_MD_PATH = join(import.meta.dir, "research-docs.md");

function readResearchDocs(): string {
  return readFileSync(RESEARCH_DOCS_MD_PATH, "utf-8");
}

function getStepA0Section(): string {
  const content = readResearchDocs();
  const stepA0Idx = content.indexOf("### Step A0:");
  const stepA1Idx = content.indexOf("### Step A1:");
  expect(stepA0Idx).toBeGreaterThan(-1);
  expect(stepA1Idx).toBeGreaterThan(-1);
  return content.slice(stepA0Idx, stepA1Idx);
}

describe("research-docs.md — Step A0 fallback uses the config-driven resolver", () => {
  it("does not instruct raw repos/* directory iteration as a repo-list source", () => {
    const section = getStepA0Section();
    expect(section).not.toContain("for dir in repos/*/");
  });

  it("references resolveScopedRepos as the fallback repo-list source", () => {
    const section = getStepA0Section();
    expect(section).toContain("resolveScopedRepos");
    expect(section).toContain("check-helpers.ts");
  });

  it("documents the fail-closed behavior of the config-driven resolver", () => {
    const section = getStepA0Section();
    expect(section.toLowerCase()).toContain("fail");
    expect(section.toLowerCase()).toContain("closed");
  });
});
