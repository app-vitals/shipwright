import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let content: string;

beforeAll(() => {
  content = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");
});

describe("error-scan SKILL.md — capped final summary (CSM-2.7)", () => {
  it("caps the final summary at 3-5 lines and keeps detail in the store", () => {
    const section =
      content.match(/## Step \d+: Print Summary[\s\S]*?\n---/)?.[0] ?? "";
    expect(section).toContain("3-5 lines");
    expect(section).toContain("ERROR SCAN COMPLETE");
    expect(section).not.toContain("error-report.md");
    expect(section).not.toContain("━");
  });
});

describe("error-scan SKILL.md — per-repo contract (PCR-3.4)", () => {
  it("requires --repo with a usage error", () => {
    expect(content).toContain("--repo org/repo");
    expect(content).toContain("**required**");
    expect(content).toContain("Usage: /error-scan --repo org/repo");
    expect(content).toContain("Error: --repo is required.");
  });

  it("keeps issue tracking in PatrolFinding and the mapping in machineState", () => {
    expect(content).toContain("PatrolFinding");
    expect(content).toContain("projectRepoMap");
    expect(content).toContain("machineState");
  });

  it("filters to this repo and counts unmapped issues without creating tasks", () => {
    expect(content).toContain("metrics.unmapped");
    expect(content).toContain("no finding and no task");
    expect(content).toContain("repo-filter.ts");
  });

  it("no longer writes error-report.md or scans multiple repo checkouts", () => {
    expect(content).not.toContain("error-report.md");
    expect(content).not.toContain('find "$SHIPWRIGHT_REPO_DIR"');
    expect(content).not.toContain("Overwrite `state/error-patrol-ledger.json`");
  });

  it("touches the legacy ledger only in the one-time import", () => {
    const mentions = content
      .split("\n")
      .filter((l) => l.includes("error-patrol-ledger.json"));
    const importSection =
      content.match(/## Step 7: One-Time Legacy Import[\s\S]*?\n---/)?.[0] ??
      "";
    for (const line of mentions) {
      expect(importSection.includes(line) || line.includes("never")).toBe(true);
    }
    expect(content).toContain("--legacy-shape error-patrol-ledger");
  });

  it("writes no finding to a repo path", () => {
    expect(content.replace(/\s+/g, " ")).toContain(
      "nothing is written to any repo path",
    );
  });
});
