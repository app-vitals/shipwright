/**
 * PR template — Closing Checklist verification requirement — T-050
 *
 * Verifies .github/pull_request_template.md exists and its body requires
 * the PR author to paste verification-command output or a CI run link
 * before merge. This is the NEW lowercase template file — distinct from
 * the existing .github/PULL_REQUEST_TEMPLATE.md (uppercase), which is
 * left untouched by this task.
 *
 * Content-assertion only: readFileSync, no I/O beyond a local file read.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const templatePath = resolve(repoRoot, ".github/pull_request_template.md");

describe("PR template — Closing Checklist verification requirement", () => {
  it("exists at .github/pull_request_template.md", () => {
    expect(existsSync(templatePath)).toBe(true);
  });

  it("includes a Closing Checklist section", () => {
    const content = readFileSync(templatePath, "utf8");
    expect(content).toMatch(/##\s+Closing Checklist/i);
  });

  it("contains the literal word 'Verification' (matches the verification command's grep)", () => {
    const content = readFileSync(templatePath, "utf8");
    expect(content).toContain("Verification");
  });

  it("requires verification-command output or a CI run link pasted into the PR body before merge", () => {
    const content = readFileSync(templatePath, "utf8");
    expect(content.toLowerCase()).toContain("verification-command output");
    expect(content.toLowerCase()).toContain("ci run link");
    expect(content.toLowerCase()).toContain("before merge");
  });
});
