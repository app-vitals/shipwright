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
  it("has frontmatter with name: security-fix", () => {
    expect(content).toContain("name: security-fix");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — reads security-report.md as input", () => {
  it("references security-report.md as the input report", () => {
    expect(content).toContain("security-report.md");
  });

  it("requires security-scan to have run first", () => {
    expect(content).toContain("/security-scan");
  });
});

describe("SKILL.md — Setup: flags", () => {
  it("documents --dry-run flag", () => {
    expect(content).toContain("--dry-run");
  });

  it("documents --rule flag", () => {
    expect(content).toContain("--rule");
  });
});

describe("SKILL.md — bulk task-store POST pattern", () => {
  it("references the /tasks/bulk endpoint", () => {
    expect(content).toContain("/tasks/bulk");
  });

  it("writes a temp file before posting", () => {
    expect(content).toContain("/tmp/security-tasks-");
  });
});

describe("SKILL.md — repo-namespaced task ID format", () => {
  it("documents the security-{rule}-{repo-slug}-{YYYY-Www} ID format", () => {
    expect(content).toContain("security-{rule}-{repo-slug}-{YYYY-Www}");
  });

  it("documents repo-slug derivation (last path segment, lowercased)", () => {
    expect(content).toContain("repo-slug");
  });

  it("explains the collision-avoidance rationale", () => {
    const hasRationale =
      content.toLowerCase().includes("collision") ||
      content.toLowerCase().includes("collide");
    expect(hasRationale).toBe(true);
  });
});

describe("SKILL.md — dedup check", () => {
  it("checks source == shipwright", () => {
    expect(content).toContain('source == "shipwright"');
  });

  it("checks title prefix 'Security fix:'", () => {
    expect(content).toContain("Security fix:");
  });

  it("documents the dedup check step (6q.1 style)", () => {
    expect(content.toLowerCase()).toContain("dedup");
  });
});

describe("SKILL.md — embedded rule classification table", () => {
  const rules = [
    "gitleaks-secret",
    "osv-cve",
    "grype-cve",
    "zizmor-lint",
    "authz-missing-check",
    "secret-weak-compare",
    "hardcoded-credential",
    "posture-security-md-missing",
    "posture-sbom-missing",
    "posture-branch-protection-missing",
  ];

  for (const rule of rules) {
    it(`classifies rule ${rule}`, () => {
      expect(content).toContain(rule);
    });
  }

  it("does not depend on references/principles.md (that's a different rule set)", () => {
    expect(content).not.toContain("references/principles.md");
  });
});

describe("SKILL.md — credential-rotation findings route through HITL", () => {
  it("mentions requires-credential-action", () => {
    expect(content).toContain("requires-credential-action");
  });

  it("has a ## Human steps section", () => {
    expect(content).toContain("## Human steps");
  });

  it("references /shipwright:hitl", () => {
    expect(content).toContain("/shipwright:hitl");
  });

  it("states credential-rotation findings are never auto-remediated", () => {
    const hasNeverAutoRemediate =
      content.toLowerCase().includes("never auto-remediated") ||
      content.toLowerCase().includes("never autonomously") ||
      content.toLowerCase().includes("not auto-remediated");
    expect(hasNeverAutoRemediate).toBe(true);
  });

  it("classifies gitleaks-secret as HITL: always / requires-credential-action: true", () => {
    const gitleaksSection = content.slice(
      content.indexOf("gitleaks-secret"),
      content.indexOf("gitleaks-secret") + 400,
    );
    expect(gitleaksSection).toContain("always");
    expect(gitleaksSection.toLowerCase()).toContain("true");
  });

  it("classifies hardcoded-credential as HITL: always / requires-credential-action: true", () => {
    const idx = content.indexOf("| `hardcoded-credential`");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx, idx + 400);
    expect(section).toContain("always");
  });
});

describe("SKILL.md — at least one autonomous PR-worthy rule is HITL: never", () => {
  it("classifies osv-cve as HITL: never", () => {
    const idx = content.indexOf("| `osv-cve`");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx, idx + 200);
    expect(section).toContain("never");
  });
});

describe("SKILL.md — Constraints section", () => {
  it("has a ## Constraints section", () => {
    expect(content).toMatch(/## Constraints/);
  });

  it("declares queue-only behavior (never opens PRs)", () => {
    expect(content.toLowerCase()).toContain("never opens prs");
  });

  it("declares one task per rule", () => {
    expect(content.toLowerCase()).toContain("one task per rule");
  });
});

describe("SKILL.md — Error Handling section", () => {
  it("has an ## Error Handling section", () => {
    expect(content).toMatch(/## Error Handling/);
  });
});
