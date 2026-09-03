import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "dependency-risk-analysis.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("dependency-risk-analysis.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("dependency-risk-analysis.md — recommendation options", () => {
  it("documents the merge recommendation", () => {
    expect(content).toContain("merge");
  });

  it("documents the review recommendation", () => {
    expect(content).toContain("review");
  });

  it("documents the hold recommendation", () => {
    expect(content).toContain("hold");
  });
});

describe("dependency-risk-analysis.md — flags to assess", () => {
  it("documents breakingChange", () => {
    expect(content).toContain("breakingChange");
  });

  it("documents securityRelevant", () => {
    expect(content).toContain("securityRelevant");
  });

  it("documents productionImpact", () => {
    expect(content).toContain("productionImpact");
  });
});

describe("dependency-risk-analysis.md — Dependabot-path heuristics", () => {
  it("references app/dependabot as the single-package path", () => {
    expect(content).toContain("app/dependabot");
  });

  it("describes patch bump heuristic", () => {
    expect(content.toLowerCase()).toContain("patch bump");
  });

  it("describes minor bump heuristic", () => {
    expect(content.toLowerCase()).toContain("minor bump");
  });

  it("describes major bump heuristic", () => {
    expect(content.toLowerCase()).toContain("major bump");
  });

  it("mentions CVE detection", () => {
    expect(content).toContain("CVE");
  });

  it("mentions devDependencies handling", () => {
    expect(content).toContain("devDependencies");
  });

  it("mentions dependencies (production) handling", () => {
    expect(content).toContain("dependencies");
  });
});

describe("dependency-risk-analysis.md — Renovate grouped-analysis section", () => {
  it("references app/renovate as the grouped path", () => {
    expect(content).toContain("app/renovate");
  });

  it("describes parsing the grouped markdown table out of the PR body", () => {
    expect(content).toContain("Package");
    expect(content).toContain("Type");
    expect(content).toContain("Update");
    expect(content).toContain("Change");
  });

  it("describes rolling multiple packages into a single PR-level recommendation", () => {
    expect(content).toMatch(/single|one/i);
    expect(content).toContain("recommendation");
    expect(content.toLowerCase()).toContain("maximum-severity");
  });

  it("notes the needs-human label convention is repo-specific", () => {
    expect(content).toContain("renovate:needs-human");
    expect(content.toLowerCase()).toContain("repo-specific");
  });

  it("notes heuristics must degrade gracefully without the label", () => {
    expect(content.toLowerCase()).toContain("degrade gracefully");
  });

  it("falls back to Dependabot heuristics for unrecognized authors", () => {
    expect(content.toLowerCase()).toContain("author mismatch");
  });
});

describe("dependency-risk-analysis.md — generic input/output framing", () => {
  it("phrases inputs in terms of a PR's diff, body, and author", () => {
    expect(content.toLowerCase()).toContain("diff");
    expect(content.toLowerCase()).toContain("body");
    expect(content).toContain("author.login");
  });

  it("does not couple to the fetch-PR gh CLI wrapper (Step 2/3 fetch logic)", () => {
    expect(content).not.toContain("gh pr view $PR");
    expect(content).not.toContain("gh pr diff $PR");
  });

  it("does not include comment-formatting/posting wrapper logic", () => {
    expect(content).not.toContain("gh pr comment");
    expect(content).not.toContain("--body-file");
  });

  it("does not include state-file management wrapper logic", () => {
    expect(content).not.toContain("state/dependency-bot-reviews.json");
  });
});
