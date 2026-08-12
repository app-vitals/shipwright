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
