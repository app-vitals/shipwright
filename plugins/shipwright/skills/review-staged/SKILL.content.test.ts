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
    const endIdx = content.indexOf("### 3c.", step3bIdx);
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

describe("SKILL.md — Step 3c is generalized to a Dependency-bot cross-check", () => {
  it("renames the step header from 'Dependabot cross-check' to 'Dependency-bot cross-check'", () => {
    expect(content).toContain("### 3c. Dependency-bot cross-check");
    expect(content).not.toContain("### 3c. Dependabot cross-check");
  });

  it("widens the author check to cover app/dependabot, app/renovate, and dependabot[bot]", () => {
    const step3cIdx = content.indexOf("### 3c. Dependency-bot cross-check");
    const endIdx = content.indexOf("### 3d.", step3cIdx);
    expect(step3cIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(step3cIdx);
    const section = content.slice(step3cIdx, endIdx);

    expect(section).toContain("dependabot[bot]");
    expect(section).toContain("app/dependabot");
    expect(section).toContain("app/renovate");
  });

  it("reads state from state/dependency-bot-reviews.json and not the old dependabot-only path", () => {
    expect(content).toContain("state/dependency-bot-reviews.json");
    expect(content).not.toContain("state/dependabot-reviews.json");
  });

  it("Step 3d presentation line derives the bot label dynamically instead of hardcoding Dependabot", () => {
    const step3dIdx = content.indexOf("### 3d. Present the PR");
    expect(step3dIdx).toBeGreaterThan(-1);
    const section = content.slice(step3dIdx, step3dIdx + 2000);

    expect(section).toContain("Dependabot");
    expect(section).toContain("Renovate");
    expect(section).not.toContain('"*Dependabot:*');
  });
});
