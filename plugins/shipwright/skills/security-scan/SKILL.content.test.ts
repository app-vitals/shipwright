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
    expect(content).toContain(
      "github.com/gitleaks/gitleaks/releases/download",
    );
    expect(content).toContain("github.com/google/osv-scanner/releases/download");
    expect(content).toContain("github.com/anchore/grype/releases/download");
    expect(content).toContain("github.com/anchore/syft/releases/download");
    expect(content).toContain("github.com/woodruffw/zizmor/releases/download");
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
