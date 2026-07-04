/**
 * Plugin absorption tests — SHE-6.1
 *
 * Verifies that content from dependabot-review, entropy-patrol, and
 * learning-loop has been absorbed into the shipwright plugin. Checks:
 *   - All required skill directories exist with SKILL.md
 *   - All required commands exist
 *   - agents/learning-dreamer.md exists
 *   - entropy-scan support files (golden-principles.yaml, references/) exist
 *   - learning-capture references/generalization-gate.md exists
 *   - No files contain old plugin-prefix invocation refs
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → plugins/shipwright/ → plugins/ → root
const pluginRoot = resolve(import.meta.dir, "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

// Collect all .md and .yaml files under pluginRoot/skills, commands, agents
function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// ── Skills ────────────────────────────────────────────────────────────────────

describe("absorbed skills — directories and SKILL.md", () => {
  const requiredSkills = [
    "triage-dependabot-pr",
    "triage-dependabot-prs",
    "entropy-fix",
    "entropy-scan",
    "learning-capture",
  ];

  for (const skill of requiredSkills) {
    it(`skills/${skill}/ directory exists`, () => {
      expect(existsSync(pluginPath("skills", skill))).toBe(true);
    });

    it(`skills/${skill}/SKILL.md exists`, () => {
      expect(existsSync(pluginPath("skills", skill, "SKILL.md"))).toBe(true);
    });
  }
});

// ── Commands ──────────────────────────────────────────────────────────────────

describe("absorbed commands", () => {
  const requiredCommands = [
    "entropy-fix.md",
    "entropy-scan.md",
    "learn-dream.md",
    "learn.md",
  ];

  for (const cmd of requiredCommands) {
    it(`commands/${cmd} exists`, () => {
      expect(existsSync(pluginPath("commands", cmd))).toBe(true);
    });
  }
});

// ── Agents ────────────────────────────────────────────────────────────────────

describe("absorbed agents", () => {
  it("agents/learning-dreamer.md exists", () => {
    expect(existsSync(pluginPath("agents", "learning-dreamer.md"))).toBe(true);
  });
});

// ── entropy-scan support files ────────────────────────────────────────────────

describe("entropy-scan support files", () => {
  it("skills/entropy-scan/golden-principles.yaml exists", () => {
    expect(
      existsSync(
        pluginPath("skills", "entropy-scan", "golden-principles.yaml"),
      ),
    ).toBe(true);
  });

  const requiredRefs = [
    "customization.md",
    "quality-log-schema.md",
    "schema.md",
  ];

  for (const ref of requiredRefs) {
    it(`skills/entropy-scan/references/${ref} exists`, () => {
      expect(
        existsSync(pluginPath("skills", "entropy-scan", "references", ref)),
      ).toBe(true);
    });
  }

  it("references/principles.md exists", () => {
    expect(existsSync(pluginPath("references", "principles.md"))).toBe(true);
  });
});

// ── entropy-scan/entropy-fix repoint to principles.md ────────────────────────

describe("entropy-scan/entropy-fix reference principles.md, not golden-principles.yaml", () => {
  const skillFiles = [
    pluginPath("skills", "entropy-scan", "SKILL.md"),
    pluginPath("skills", "entropy-fix", "SKILL.md"),
  ];

  for (const file of skillFiles) {
    const relPath = file.replace(`${pluginRoot}/`, "");

    it(`${relPath} does not reference golden-principles.yaml`, () => {
      const content = readFileSync(file, "utf8");
      expect(content.includes("golden-principles.yaml")).toBe(false);
    });

    it(`${relPath} references principles.md`, () => {
      const content = readFileSync(file, "utf8");
      expect(content.includes("principles.md")).toBe(true);
    });
  }
});

// ── entropy-fix queue-only + HITL classification ─────────────────────────────

describe("entropy-fix SKILL.md is queue-only with HITL classification", () => {
  const skillFile = pluginPath("skills", "entropy-fix", "SKILL.md");
  const content = readFileSync(skillFile, "utf8");

  it("does not contain a PR-mode section header", () => {
    expect(content.includes("Step 6 (PR Mode)")).toBe(false);
  });

  it("does not contain a direct gh pr create path", () => {
    expect(content.includes("gh pr create")).toBe(false);
  });

  it("contains a task-store cross-check step", () => {
    expect(content.toLowerCase().includes("cross-check")).toBe(true);
  });

  it("does not contain an inline yes/no confirmation prompt", () => {
    expect(content.includes("(yes/no)")).toBe(false);
  });

  it("contains a hitl field in the task JSON section", () => {
    expect(content.includes('"hitl"')).toBe(true);
  });
});

// ── learning-capture support files ───────────────────────────────────────────

describe("learning-capture support files", () => {
  it("skills/learning-capture/references/generalization-gate.md exists", () => {
    expect(
      existsSync(
        pluginPath(
          "skills",
          "learning-capture",
          "references",
          "generalization-gate.md",
        ),
      ),
    ).toBe(true);
  });
});

// ── No old plugin-prefix invocation refs ─────────────────────────────────────

describe("no old plugin-prefix invocation references", () => {
  const oldPrefixes = [
    "entropy-patrol:entropy-scan",
    "entropy-patrol:entropy-fix",
    "/entropy-patrol:entropy-scan",
    "/entropy-patrol:entropy-fix",
    "dependabot-review:triage-dependabot-prs",
    "dependabot-review:triage-dependabot-pr",
    "learning-loop:learning-capture",
  ];

  // Scan all .md and .yaml files under skills/, commands/, agents/
  const dirsToScan = ["skills", "commands", "agents"].map((d) => pluginPath(d));

  let allFiles: string[] = [];
  for (const dir of dirsToScan) {
    allFiles = allFiles.concat(collectFiles(dir));
  }

  for (const prefix of oldPrefixes) {
    it(`no file contains old ref: "${prefix}"`, () => {
      const violations: string[] = [];
      for (const file of allFiles) {
        const content = readFileSync(file, "utf8");
        if (content.includes(prefix)) {
          violations.push(file.replace(`${pluginRoot}/`, ""));
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
