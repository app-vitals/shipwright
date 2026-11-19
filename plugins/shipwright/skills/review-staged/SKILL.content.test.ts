import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  if (existsSync(SKILL_MD_PATH)) {
    content = readFileSync(SKILL_MD_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — Step 3b stale-check references record.reviewedCommitSha, not record.commitSha", () => {
  it("references record.reviewedCommitSha in the Stale staged review gate", () => {
    const step3bIdx = content.indexOf("### 3b. Apply skip gates");
    const endIdx = content.indexOf("### 3c. Present the PR", step3bIdx);
    expect(step3bIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(step3bIdx);
    const section = content.slice(step3bIdx, endIdx);

    expect(section).toContain("record.reviewedCommitSha");
    expect(section).not.toContain("record.commitSha");
  });

  it("has no remaining record.commitSha references anywhere in the file", () => {
    expect(content).not.toContain("record.commitSha");
  });
});

describe("SKILL.md — the dependency-bot cross-check step is retired (DBR-3.4)", () => {
  it("has no dependency-bot cross-check step", () => {
    expect(content).not.toContain("Dependency-bot cross-check");
    expect(content).not.toContain("Dependabot cross-check");
  });

  it("no longer reads the retired dependency-bot triage state file", () => {
    expect(content).not.toContain("state/dependency-bot-reviews.json");
    expect(content).not.toContain("state/dependabot-reviews.json");
  });

  it("has no leftover dependency-bot presentation line in the Present the PR block", () => {
    expect(content).not.toContain("*{Dependabot|Renovate}:*");
    expect(content).not.toContain('"*Dependabot:*');
    expect(content).not.toContain("dependency-bot-review");
  });

  it("renumbers Present the PR to 3c with no numbering gap in Step 3", () => {
    expect(content).toContain("### 3c. Present the PR");
    expect(content).not.toContain("### 3d.");
  });
});

describe("SKILL.md — worktree path convention", () => {
  it("uses SHIPWRIGHT_WORKTREE_DIR env var form instead of hardcoded ~/worktrees", () => {
    expect(content).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell worktree-path placeholder in asserted skill text, not JS interpolation
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}",
    );
    expect(content).not.toContain("~/worktrees/{repo}-{branch-slug}");
  });
});

describe("SKILL.md — concise presentation (CSM-2.6)", () => {
  it("presents headline + max 3 bullets with the ask last", () => {
    expect(content).toContain("at most 3 bullets");
    expect(content).toContain("one phone\nscreen");
    const block = content.slice(content.indexOf("### 3c."), content.indexOf("## 4."));
    expect(block.indexOf("What do you want to do?")).toBeGreaterThan(block.indexOf("*PR #{pr}"));
  });

  it("offers numbered options 1 post / 2 skip / 3 draft / 4 discuss", () => {
    expect(content).toContain("1 post · 2 skip · 3 draft · 4 discuss");
  });

  it("no longer prints the verbose Why/Changes grid", () => {
    expect(content).not.toContain("*Why:*");
    expect(content).not.toContain("*Concerns (");
  });
});
