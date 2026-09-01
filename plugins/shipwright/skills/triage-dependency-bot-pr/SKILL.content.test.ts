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

describe("SKILL.md — frontmatter", () => {
  it("name is triage-dependency-bot-pr", () => {
    expect(content).toMatch(/name:\s*triage-dependency-bot-pr/);
  });

  it("description mentions both Dependabot and Renovate", () => {
    const frontmatterEnd = content.indexOf("---", content.indexOf("---") + 3);
    const frontmatter = content.slice(0, frontmatterEnd);
    expect(frontmatter).toContain("Dependabot");
    expect(frontmatter).toContain("Renovate");
  });

  it("description no longer claims it does not post to GitHub", () => {
    const frontmatterEnd = content.indexOf("---", content.indexOf("---") + 3);
    const frontmatter = content.slice(0, frontmatterEnd);
    expect(frontmatter).not.toContain("Does not post to GitHub");
  });
});

describe("SKILL.md — Step 2 fetch PR context includes headRefOid and labels", () => {
  it("requests headRefOid in the --json field list", () => {
    expect(content).toContain("headRefOid");
  });

  it("requests labels in the --json field list", () => {
    const jsonFieldsMatch = content.match(/gh pr view \$PR --repo \$REPO --json ([^\s\n]+)/);
    expect(jsonFieldsMatch).not.toBeNull();
    expect(jsonFieldsMatch?.[1]).toContain("labels");
  });
});

describe("SKILL.md — Renovate grouped-analysis section", () => {
  it("branches risk analysis by author.login", () => {
    expect(content).toContain("author.login");
  });

  it("references app/dependabot as the Dependabot path", () => {
    expect(content).toContain("app/dependabot");
  });

  it("references app/renovate as the Renovate path", () => {
    expect(content).toContain("app/renovate");
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

describe("SKILL.md — idempotency check", () => {
  it("uses the skill-specific commit-scoped marker", () => {
    expect(content).toContain("<!-- shipwright:dependency-bot-triage:");
  });

  it("checks existing PR comments before posting/staging", () => {
    expect(content).toContain("gh api");
    expect(content).toContain("issues/$PR/comments");
  });

  it("no longer uses the old generic shipwright-only marker as this skill's footer", () => {
    expect(content).not.toMatch(/<sub>[^<]*<\/sub><!-- shipwright -->/);
  });
});

describe("SKILL.md — policy-driven post-or-stage flow", () => {
  it("reads auto_post_dependency_bot_triage from state/agent-policy.md", () => {
    expect(content).toContain("auto_post_dependency_bot_triage");
    expect(content).toContain("state/agent-policy.md");
  });

  it("auto-post branch calls gh pr comment with --body-file", () => {
    const idx = content.indexOf("auto_post_dependency_bot_triage");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx);
    expect(section).toContain("gh pr comment");
    expect(section).toContain("--body-file");
  });

  it("stage branch writes to state/dependency-bot-reviews/", () => {
    expect(content).toContain("state/dependency-bot-reviews/");
  });
});

describe("SKILL.md — renamed state paths", () => {
  it("has no remaining references to the old dependabot-reviews path", () => {
    expect(content).not.toMatch(/(?<!-)dependabot-reviews/);
  });

  it("references the new state/dependency-bot-reviews.json file", () => {
    expect(content).toContain("state/dependency-bot-reviews.json");
  });
});
