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

describe("SKILL.md — Tier 1 tool binaries staged outside the scan target", () => {
  it("establishes a mktemp -d staging directory before Step 3.1's gitleaks download", () => {
    const mktempIndex = content.indexOf("mktemp -d");
    const gitleaksStepIndex = content.indexOf("### 3.1 gitleaks");
    expect(mktempIndex).toBeGreaterThan(-1);
    expect(gitleaksStepIndex).toBeGreaterThan(-1);
    expect(mktempIndex).toBeLessThan(gitleaksStepIndex);
  });

  it("stores the staging directory in a reusable shell variable", () => {
    expect(content).toMatch(/TOOLS_DIR=.*mktemp -d/);
  });

  for (const tool of ["gitleaks", "osv-scanner", "grype", "syft", "zizmor"]) {
    it(`downloads ${tool} into the staging directory, not the repo root`, () => {
      const sectionHeader = `### 3.${["gitleaks", "osv-scanner", "grype", "syft", "zizmor"].indexOf(tool) + 1} ${tool}`;
      const startIndex = content.indexOf(sectionHeader);
      expect(startIndex).toBeGreaterThan(-1);
      const nextHeaderMatch = content.slice(startIndex + 1).search(/\n### 3\.\d/);
      const endIndex =
        nextHeaderMatch === -1 ? content.length : startIndex + 1 + nextHeaderMatch;
      const section = content.slice(startIndex, endIndex);
      expect(section).toContain("$TOOLS_DIR");
      // The curl -o destination must not be a bare filename in the repo root.
      const curlLine = section
        .split("\n")
        .find((line) => line.trim().startsWith("curl -sSfL"));
      expect(curlLine).toBeDefined();
      expect(curlLine).toContain("$TOOLS_DIR");
    });
  }

  it("invokes grype from the staging directory while still scanning the repo root (dir:.)", () => {
    const grypeSection = content.slice(
      content.indexOf("### 3.3 grype"),
      content.indexOf("### 3.4 syft"),
    );
    expect(grypeSection).toMatch(/\$TOOLS_DIR\/grype"? dir:\./);
  });

  it("invokes syft from the staging directory while still scanning the repo root (dir:.)", () => {
    const syftSection = content.slice(
      content.indexOf("### 3.4 syft"),
      content.indexOf("### 3.5 zizmor"),
    );
    expect(syftSection).toMatch(/\$TOOLS_DIR\/syft"? dir:\./);
  });

  it("still passes the node_modules/worktrees --exclude flags on grype's dir:. invocation", () => {
    const grypeSection = content.slice(
      content.indexOf("### 3.3 grype"),
      content.indexOf("### 3.4 syft"),
    );
    expect(grypeSection).toContain("--exclude './node_modules/**'");
    expect(grypeSection).toContain("--exclude './worktrees/**'");
  });

  it("still passes the node_modules/worktrees --exclude flags on syft's dir:. invocation", () => {
    const syftSection = content.slice(
      content.indexOf("### 3.4 syft"),
      content.indexOf("### 3.5 zizmor"),
    );
    expect(syftSection).toContain("--exclude './node_modules/**'");
    expect(syftSection).toContain("--exclude './worktrees/**'");
  });

  it("explains why staging outside the repo root prevents tool-binary self-pollution", () => {
    const text = content.toLowerCase();
    const mentionsSelfPollution =
      text.includes("self-pollut") ||
      text.includes("its own embedded") ||
      text.includes("binary classifier");
    expect(mentionsSelfPollution).toBe(true);
  });
});

describe("SKILL.md — osv-cve authoritative for bun.lock dependency CVEs", () => {
  it("documents osv-scanner/osv-cve as the authoritative dependency-CVE source for Bun-lockfile repos", () => {
    const text = content.toLowerCase();
    expect(text).toContain("bun.lock");
    const hasAuthority =
      text.includes("authoritative") || text.includes("authority");
    expect(hasAuthority).toBe(true);
  });

  it("documents grype-cve as a narrow, non-independent subset rather than corroboration", () => {
    const text = content.toLowerCase();
    const hasSubset = text.includes("subset");
    const hasNotCorroboration =
      text.includes("not independent") ||
      text.includes("non-independent") ||
      text.includes("not corroborat");
    expect(hasSubset).toBe(true);
    expect(hasNotCorroboration).toBe(true);
  });

  it("explains the root cause: syft/grype only partially parse this org's bun.lock format", () => {
    const text = content.toLowerCase();
    const mentionsParsing =
      text.includes("partially parse") || text.includes("only partially");
    expect(mentionsParsing).toBe(true);
  });
});

describe("SKILL.md — Step 3.5a zizmor.yml suppression filter", () => {
  it("has a Step 3.5a subsection for suppressing zizmor findings covered by .github/zizmor.yml", () => {
    expect(content).toContain("3.5a");
    expect(content).toContain(".github/zizmor.yml");
  });

  it("is positioned between Step 3.5 and Step 4 (scoped to zizmor specifically)", () => {
    const start = content.indexOf("### 3.5a");
    const step35End = content.indexOf(
      "If the repo has no `.github/workflows/` directory",
    );
    const step4Start = content.indexOf("## Step 4:");
    expect(start).toBeGreaterThan(-1);
    expect(step35End).toBeGreaterThan(-1);
    expect(step4Start).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(step35End);
    expect(start).toBeLessThan(step4Start);
  });

  it("explains zizmor's own line-based ignore matching is unreliable due to line drift", () => {
    const text = content.toLowerCase();
    const hasDrift =
      text.includes("line drift") || text.includes("line-based");
    const hasUnreliable =
      text.includes("unreliable") || text.includes("fragile");
    expect(hasDrift).toBe(true);
    expect(hasUnreliable).toBe(true);
  });

  it("instructs skipping the filter entirely when .github/zizmor.yml does not exist", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    expect(section.toLowerCase()).toContain("does not exist");
    expect(section.toLowerCase()).toContain("skip");
  });

  it("documents parsing ignore entries into rule/file/line/stepName tuples", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    expect(section).toContain("stepName");
  });

  it("documents a small line tolerance for matching (e.g. ±5 lines)", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    expect(section.toLowerCase()).toContain("tolerance");
    expect(section).toContain("5");
  });

  it("documents re-resolving the ignore entry's line via the named step comment as a fallback match", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    expect(section.toLowerCase()).toContain("step name");
  });

  it("documents that a non-matching rule+file keeps the finding (not suppressed)", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    expect(section.toLowerCase()).toContain("not suppressed");
  });

  it("documents that suppressed findings are dropped before Step 6 and never reach the report or ledger", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    const text = section.toLowerCase();
    expect(text).toContain("step 6");
    expect(text.includes("security-report.md") || text.includes("report")).toBe(
      true,
    );
    expect(text).toContain("ledger");
  });

  it("references the live ignore-entry format from this repo's own .github/zizmor.yml", () => {
    const section = content.slice(
      content.indexOf("### 3.5a"),
      content.indexOf("## Step 4:"),
    );
    expect(section).toContain("auto-bump-chart.yml:178");
  });

  it("cross-references the zizmor suppression filter at the top of Step 6", () => {
    const step6Section = content.slice(
      content.indexOf("## Step 6:"),
      content.indexOf("## Step 7:"),
    );
    expect(step6Section.toLowerCase()).toContain("3.5a");
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
