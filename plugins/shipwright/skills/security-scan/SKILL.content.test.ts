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
  it("has frontmatter with name: security-scan", () => {
    expect(content).toContain("name: security-scan");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — report-only, no code changes", () => {
  it("declares it makes no code changes", () => {
    expect(content).toContain("No code changes");
  });

  it("declares no git operations", () => {
    expect(content).toContain("No git operations");
  });

  it("declares no PR creation", () => {
    expect(content).toContain("No PR creation");
  });

  it("has a Constraints section", () => {
    expect(content).toMatch(/## Constraints/);
  });
});

describe("SKILL.md — three-tier structure", () => {
  it("documents Tier 1 (real binaries)", () => {
    expect(content).toContain("Tier 1");
  });

  it("documents Tier 2 (LLM-driven checks)", () => {
    expect(content).toContain("Tier 2");
  });

  it("documents Tier 3 (posture checks)", () => {
    expect(content).toContain("Tier 3");
  });
});

describe("SKILL.md — Tier 1 pinned-version + sha256 download steps", () => {
  const tools = ["gitleaks", "osv-scanner", "grype", "syft", "zizmor"];

  for (const tool of tools) {
    it(`documents a download step for ${tool}`, () => {
      expect(content).toContain(tool);
    });
  }

  it("uses sha256sum -c checksum verification (matching ci.yml gitleaks pattern)", () => {
    expect(content).toContain("sha256sum -c");
  });

  it("uses curl -sSfL to download pinned release assets", () => {
    expect(content).toContain("curl -sSfL");
  });

  it("pins the gitleaks version matching ci.yml (v8.27.2)", () => {
    expect(content).toContain("v8.27.2");
  });

  it("references pinned release download URLs for each tool", () => {
    expect(content).toContain("github.com/gitleaks/gitleaks/releases/download");
    expect(content).toContain(
      "github.com/google/osv-scanner/releases/download",
    );
    expect(content).toContain("github.com/anchore/grype/releases/download");
    expect(content).toContain("github.com/anchore/syft/releases/download");
    expect(content).toContain("github.com/zizmorcore/zizmor/releases/download");
  });
});

describe("SKILL.md — Step 3.1 gitleaks .gitleaksignore auto-discovery", () => {
  it("documents that .gitleaksignore is auto-discovered at the scan source root", () => {
    expect(content).toContain(".gitleaksignore");
  });

  it("documents the fingerprint format commit:file:rule:startLine", () => {
    expect(content).toContain("commit:file:rule:startLine");
  });

  it("documents that suppression entries are added only via human HITL confirmation", () => {
    const text = content.toLowerCase();
    const hasHITL =
      text.includes("hitl") || text.includes("human") || text.includes("closing");
    const hasNeverAuto =
      text.includes("never automatically") ||
      text.includes("not automatically") ||
      text.includes("human confirming") ||
      text.includes("only");
    expect(hasHITL && hasNeverAuto).toBe(true);
  });
});

describe("SKILL.md — per-tool fallback behavior", () => {
  it("documents that a failed tool download is skipped, not fatal", () => {
    const hasFallback =
      content.toLowerCase().includes("fallback") ||
      content.toLowerCase().includes("skip");
    expect(hasFallback).toBe(true);
  });

  it("states the scan never aborts because one tool failed to download", () => {
    const hasNeverAbort =
      content.includes("never fail") ||
      content.includes("never abort") ||
      content.includes("must never fail") ||
      content.includes("do not fail") ||
      content.includes("continue with the remaining");
    expect(hasNeverAbort).toBe(true);
  });

  it("notes the gap in the report when a tool is skipped", () => {
    expect(content.toLowerCase()).toContain("download failed");
  });
});

describe("SKILL.md — Trivy exclusion note", () => {
  it("explicitly excludes Trivy", () => {
    expect(content).toContain("Trivy");
  });

  it("references the March 2026 supply-chain compromise advisory", () => {
    expect(content).toContain("GHSA-69fq-xp46-6x23");
  });

  it("states Grype+Syft are used instead", () => {
    const hasReplacement =
      content.includes("Grype") && content.includes("Syft");
    expect(hasReplacement).toBe(true);
  });
});

describe("SKILL.md — Tier 2 LLM-driven checks", () => {
  it("mentions authn/authz pattern review", () => {
    const hasAuthz =
      content.toLowerCase().includes("authz") ||
      content.toLowerCase().includes("authorization");
    expect(hasAuthz).toBe(true);
  });

  it("mentions hardcoded credential checks", () => {
    const hasCreds =
      content.toLowerCase().includes("hardcoded credential") ||
      content.toLowerCase().includes("hardcoded-credential");
    expect(hasCreds).toBe(true);
  });
});

describe("SKILL.md — Tier 3 posture checks", () => {
  it("checks for SECURITY.md presence", () => {
    expect(content).toContain("SECURITY.md");
  });

  it("checks for SBOM presence", () => {
    expect(content).toContain("SBOM");
  });

  it("checks branch-protection status", () => {
    expect(content.toLowerCase()).toContain("branch protection");
  });
});

describe("SKILL.md — environment-artifact noise filtering (Tier 1 scan targets)", () => {
  it("excludes node_modules from grype's scan target via --exclude", () => {
    const grypeSection = content.slice(
      content.indexOf("### 3.3 grype"),
      content.indexOf("### 3.4 syft"),
    );
    expect(grypeSection).toContain("--exclude");
    expect(grypeSection).toContain("node_modules");
  });

  it("excludes worktrees from grype's scan target via --exclude", () => {
    const grypeSection = content.slice(
      content.indexOf("### 3.3 grype"),
      content.indexOf("### 3.4 syft"),
    );
    expect(grypeSection).toContain("--exclude");
    expect(grypeSection).toContain("worktrees");
  });

  it("excludes node_modules and worktrees from syft's scan target via --exclude", () => {
    const syftSection = content.slice(
      content.indexOf("### 3.4 syft"),
      content.indexOf("### 3.5 zizmor"),
    );
    expect(syftSection).toContain("--exclude");
    expect(syftSection).toContain("node_modules");
    expect(syftSection).toContain("worktrees");
  });

  it("documents that osv-scanner has no --exclude flag and uses .git/info/exclude instead", () => {
    const osvSection = content.slice(
      content.indexOf("### 3.2 osv-scanner"),
      content.indexOf("### 3.3 grype"),
    );
    expect(osvSection).toContain(".git/info/exclude");
    expect(osvSection).toContain("worktrees");
  });

  it("clarifies .git/info/exclude writes are not tracked-file changes or git operations", () => {
    expect(content).toContain(".git/info/exclude");
    const text = content.toLowerCase();
    const hasClarification =
      text.includes("not a git operation") ||
      text.includes("never the tracked .gitignore") ||
      text.includes("not the tracked .gitignore");
    expect(hasClarification).toBe(true);
  });

  it("explains the rationale: leftover worktree/node_modules artifacts causing false-positive noise", () => {
    const text = content.toLowerCase();
    const hasRationale =
      text.includes("false-positive") || text.includes("false positive");
    const mentionsArtifacts =
      text.includes("environment artifact") || text.includes("scan-environment noise");
    expect(hasRationale).toBe(true);
    expect(mentionsArtifacts).toBe(true);
  });
});

describe("SKILL.md — ledger classification with repo-namespaced keys", () => {
  it("references the security-patrol ledger location", () => {
    expect(content).toContain("state/security-patrol-ledger.json");
  });

  it("classifies findings as new", () => {
    expect(content).toContain("New");
  });

  it("classifies findings as regressed", () => {
    expect(content).toContain("Regressed");
  });

  it("classifies findings as unchanged", () => {
    expect(content).toContain("Unchanged");
  });

  it("namespaces ledger keys / finding IDs by repo slug and ISO week", () => {
    // The repo-namespaced ID format that avoids entropy-fix's task-ID
    // collision bug: security-{rule}-{repo-slug}-{YYYY-Www}
    expect(content).toContain("security-{rule}-{repo-slug}-{YYYY-Www}");
  });

  it("explains the repo-namespacing rationale (multi-repo same-week collision)", () => {
    const hasRationale =
      content.toLowerCase().includes("collision") ||
      content.toLowerCase().includes("collide");
    expect(hasRationale).toBe(true);
  });

  it("documents repo-slug derivation (last path segment, lowercased)", () => {
    expect(content).toContain("repo-slug");
  });
});
