import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf-8");
const scan = read("SKILL.md");
const fix = read("../environments-fix/SKILL.md");

describe("environments-scan SKILL.md", () => {
  it("has frontmatter and is report only", () => {
    expect(scan).toContain("name: environments-scan");
    expect(scan).toContain("No code changes");
    expect(scan).toContain("No task creation");
  });

  it("requires --repo and prints usage before any work", () => {
    expect(scan).toContain(
      "Usage: /shipwright:environments-scan --repo org/repo",
    );
    expect(scan.indexOf("Usage:")).toBeLessThan(scan.indexOf("## Step 0"));
  });

  it("covers every environments readiness check", () => {
    for (const id of [
      "lockfile",
      "tool-versions",
      "preview-environment",
      "structured-logging",
      "error-tracking",
      "tracing-metrics",
      "staged-canary",
    ])
      expect(scan).toContain(`**${id}**`);
  });

  it("defines preview detection as entry point plus CI job", () => {
    expect(scan).toContain("bring-up entry point");
    expect(scan).toContain("CI job that runs tests against it");
  });

  it("writes only docs/patrols/environments.md, PR only on material change", () => {
    expect(scan).toContain("docs/patrols/environments.md");
    expect(scan).toContain("check-patrol-docs.ts");
    expect(scan).toContain("150 lines");
    expect(scan).toContain("PR only on material change");
  });

  it("uses the cron-run recorder with the environments cron id", () => {
    expect(scan).toContain("cron-run-recorder.ts");
    expect(scan).toContain("--cron environments");
  });
});

describe("environments-fix SKILL.md", () => {
  it("requires --repo and routes auto/review/plan with cron provenance", () => {
    expect(fix).toContain(
      "Usage: /shipwright:environments-fix --repo org/repo",
    );
    expect(fix).toContain('originRef: "environments"');
    expect(fix).toContain("needs-review:");
    expect(fix).toContain("`kind: prd`, `hitl: true`");
  });

  it("dedups and records one run", () => {
    expect(fix).toContain("queues nothing");
    expect(fix).toContain("--cron environments");
    expect(fix).toContain("docs/task-store.md");
  });
});
