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

describe("research-docs.md — measured-values guard (NMV-1.2)", () => {
  const content = readResearchDocs();

  it("defines a 6.5d measured-values check citing the recipe rule and file:line", () => {
    const start = content.indexOf("### 6.5d: Measured Values");
    expect(start).toBeGreaterThan(-1);
    const section = content.slice(start, content.indexOf("### Presenting flags"));
    expect(section).toContain("references/doc-refresh-recipe.md");
    expect(section).toContain("Measured values");
    expect(section).toContain("`file:line`");
  });

  it("applies 6.5d in auto-mode Step A5.5", () => {
    const start = content.indexOf("### Step A5.5:");
    const section = content.slice(start, content.indexOf("Track a running count", start));
    expect(section).toContain("6.5d");
    expect(section).toContain("Review {doc} for observed measured value");
  });

  it("Path A digest links observed figures but still digests budgets and targets", () => {
    const start = content.indexOf("**Path A");
    const section = content.slice(start, content.indexOf("**Path B"));
    expect(section).toContain("Measured-values guard");
    expect(section).toContain("linked to, never copied");
    expect(section).toContain("speed budgets and coverage targets");
  });
});

describe("research-docs.md — explicit --repo input", () => {
  it("documents --repo in the argument hint", () => {
    expect(readResearchDocs()).toMatch(/argument-hint:.*--repo org\/repo/);
  });

  it("Step A0 has an explicit-repo path that skips the precheck and repos/ scan", () => {
    const a0 = getStepA0Section();
    expect(a0).toContain("`--repo org/repo`");
    expect(a0).toContain("skip the precheck-driven list");
    expect(a0).toContain("git clone");
    expect(a0).toContain("Without `--repo`, behavior is unchanged");
  });
});
