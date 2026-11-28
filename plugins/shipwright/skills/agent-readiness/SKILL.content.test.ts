import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf-8");
const skill = read("SKILL.md");
const command = read("../../commands/agent-readiness.md");

describe("agent-readiness SKILL.md", () => {
  it("has frontmatter naming the skill", () => {
    expect(skill).toContain("name: agent-readiness");
    expect(command).toContain("name: agent-readiness");
  });

  it("requires --repo and prints a usage error before any work", () => {
    expect(skill).toContain(
      "Usage: /shipwright:agent-readiness --repo org/repo",
    );
    expect(skill.indexOf("Usage:")).toBeLessThan(skill.indexOf("## Step 1"));
    expect(command).toContain("--repo");
  });

  it("runs the deterministic scorer with no model judgment", () => {
    expect(skill).toContain("agent-readiness-scorer.ts");
    expect(skill).toContain("No model judgment");
  });

  it("queues no tasks and writes no repo files", () => {
    expect(skill).toContain("No task creation");
    expect(skill).toContain("No repo files");
  });

  it("links the system-cron contract exemptions", () => {
    expect(skill).toContain("docs/task-store.md");
  });
});
