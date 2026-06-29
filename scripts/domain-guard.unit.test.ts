/**
 * scripts/domain-guard.unit.test.ts
 *
 * Regression guard: ensures shipwright-harness.com (hyphenated domain) appears
 * ONLY in the two allowed files (site/vercel.json for redirects and brand/BRAND.md
 * to document the redirect mapping). The canonical domain is shipwrightharness.com
 * (no hyphen), and all internal references should use the canonical form.
 *
 * This test prevents accidental introduction of stray-hyphen references in
 * documentation, config files, or code.
 */

import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("domain-guard: shipwright-harness.com references", () => {
  function getProjectRoot(): string {
    const scriptDir = import.meta.dirname ?? process.cwd();
    return join(scriptDir, "..");
  }

  test("shipwright-harness.com appears only in allowed files", () => {
    const projectRoot = getProjectRoot();
    const ALLOWED_FILES = [
      "site/vercel.json", // redirect source (hyphenated domain)
      "brand/BRAND.md", // documents redirect mapping
    ];

    // Grep the entire repo for the hyphenated domain, excluding .git, node_modules, and this test file
    const grepCmd = `grep -r "shipwright-harness\\.com" --exclude-dir=".git" --exclude-dir="node_modules" --exclude-dir="worktrees" --exclude-dir="dist" --exclude-dir=".next" --exclude-dir="build" --exclude-dir="coverage" --exclude-dir=".turbo" --exclude-dir="planning" --exclude="domain-guard.unit.test.ts" "${projectRoot}"`;

    let output = "";
    try {
      output = execSync(grepCmd, { encoding: "utf8", stdio: "pipe" }).trim();
    } catch (e) {
      // grep exits 1 if no matches found — that's success
      if (e instanceof Error && "status" in e && e.status === 1) {
        // No matches found; test passes
        return;
      }
      throw e;
    }

    if (!output) {
      // No matches found; test passes
      return;
    }

    // Parse grep output (format: filepath:line content)
    const lines = output.split("\n").filter((l) => l.trim());
    const violations: string[] = [];

    for (const line of lines) {
      const match = line.match(/^([^:]+):/);
      if (!match) continue;

      const filePath = match[1];
      // Check if this file is in the allowed list
      const isAllowed = ALLOWED_FILES.some(
        (allowed) => filePath.endsWith(allowed) || filePath.includes(allowed),
      );

      if (!isAllowed) {
        violations.push(line);
      }
    }

    expect(violations).toHaveLength(
      0,
      `Found stray shipwright-harness.com (hyphenated) references outside allowed files:\n${violations.join("\n")}`,
    );
  });

  test("canonical domain (shipwrightharness.com) is used in CLAUDE.md, docs/architecture.md, and charts/shipwright/Chart.yaml", () => {
    const projectRoot = getProjectRoot();
    const REQUIRED_CANONICAL_FILES = [
      "CLAUDE.md",
      "docs/architecture.md",
      "charts/shipwright/Chart.yaml",
    ];

    const grepCmd = `grep -r "shipwrightharness\\.com" --exclude-dir=".git" --exclude-dir="node_modules" --exclude-dir="worktrees" --exclude="domain-guard.unit.test.ts" "${projectRoot}"`;

    let output = "";
    try {
      output = execSync(grepCmd, { encoding: "utf8", stdio: "pipe" }).trim();
    } catch (e) {
      // grep exits 1 if no matches found — that's failure
      if (e instanceof Error && "status" in e && e.status === 1) {
        throw new Error(
          `Expected to find canonical domain (shipwrightharness.com) in at least one of: ${REQUIRED_CANONICAL_FILES.join(", ")}`,
        );
      }
      throw e;
    }

    expect(output.length).toBeGreaterThan(
      0,
      "Expected to find canonical domain (shipwrightharness.com) in repo",
    );

    const lines = output.split("\n").filter((l) => l.trim());
    const foundInRequired = REQUIRED_CANONICAL_FILES.map((file) =>
      lines.some((line) => line.includes(file)),
    );

    expect(foundInRequired.every((found) => found)).toBe(
      true,
      `Expected canonical domain to appear in all of: ${REQUIRED_CANONICAL_FILES.join(", ")}`,
    );
  });
});
