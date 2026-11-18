/**
 * research-docs.md content tests — Step A0 requires an explicit --repo.
 *
 * SCR-1.5: the agent-level docs-freshness cron and its check-docs-freshness.ts
 * precheck are gone; the admin system-cron scheduler queues one task per repo
 * with `--repo org/repo`. Auto mode no longer scans repos/ or resolves a list.
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

describe("research-docs.md — Step A0 requires --repo", () => {
  it("does not instruct repos/* iteration or the config-driven resolver", () => {
    const section = getStepA0Section();
    expect(section).not.toContain("for dir in repos/*/");
    expect(section).not.toContain("resolveScopedRepos");
  });

  it("fails with a usage message when --repo is missing", () => {
    const section = getStepA0Section();
    expect(section).toContain("`--repo org/repo` is required");
    expect(section).toContain(
      "Usage: /shipwright:research-docs --auto --repo org/repo",
    );
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
  it("documents --repo (required with --auto) in the argument hint", () => {
    expect(readResearchDocs()).toMatch(/argument-hint:.*--auto --repo org\/repo/);
  });

  it("Step A0 finds or clones the repo and pulls it", () => {
    const a0 = getStepA0Section();
    expect(a0).toContain("git clone");
    expect(a0).toContain("git remote get-url origin");
  });
});

describe("SCM-8.2 — auto-mode follow-on tasks carry the cron origin", () => {
  function autoSection(): string {
    const c = readResearchDocs();
    return c.slice(c.indexOf("### Step A5.5:"), c.indexOf("### Step A7.5:"));
  }

  it("stamps originKind cron and originRef docs-freshness", () => {
    const s = autoSection();
    expect(s).toContain('`originKind: "cron"`');
    expect(s).toContain('`originRef: "docs-freshness"`');
  });

  it("adds repo and source docs-freshness if missing", () => {
    const s = autoSection();
    expect(s).toContain('`source: "docs-freshness"`');
    expect(s).toContain("`repo`");
  });

  it("applies to both Step A5.5 and Step A7 payloads", () => {
    const c = readResearchDocs();
    const a55 = c.slice(c.indexOf("### Step A5.5:"), c.indexOf("### Step A6:"));
    const a7 = c.slice(c.indexOf("### Step A7:"), c.indexOf("### Step A7.5:"));
    expect(a55).toContain('originRef: "docs-freshness"');
    expect(a7).toContain('originRef: "docs-freshness"');
  });
});
