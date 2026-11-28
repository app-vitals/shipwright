import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let content: string;

beforeAll(() => {
  content = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");
});

describe("error-resolve SKILL.md — per-repo contract (PCR-3.4)", () => {
  it("requires --repo with a usage error", () => {
    expect(content).toContain("Usage: /error-resolve --repo org/repo");
    expect(content).toContain("Error: --repo is required.");
  });

  it("reads the finding-to-task link and task status from the store", () => {
    expect(content).toContain("/patrol-findings?cronId=");
    expect(content).toContain("taskId");
    expect(content).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/{taskId}");
  });

  it("resolves only on deployed/done and never on merged, released or pr_open", () => {
    expect(content).toContain(
      "only when its gating task is `deployed` or `done`",
    );
    expect(content).toContain("never `merged`");
    expect(content).toContain("`pr_open`");
    const gate = content.indexOf("## Step 3");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(content.indexOf("## Step 6"));
  });

  it("touches no ledger file and no repo path", () => {
    expect(content).not.toContain("error-patrol-ledger");
    expect(content).not.toContain("error-report.md");
    expect(content).not.toContain("taskLinks");
  });

  it("marks the finding resolved only after the Sentry call succeeds", () => {
    expect(content).toContain(
      "Never write the store before the Sentry call succeeds",
    );
  });
});
