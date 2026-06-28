import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_TASK_MD_PATH = join(import.meta.dir, "dev-task.md");

let content: string;

beforeAll(() => {
  content = readFileSync(DEV_TASK_MD_PATH, "utf-8");
});

describe("dev-task.md Step 1 — in_progress resume safeguard", () => {
  it("checks for in_progress tasks before ready=true query", () => {
    const inProgressIdx = content.indexOf("status=in_progress");
    const readyIdx = content.indexOf("ready=true");
    expect(inProgressIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeGreaterThan(-1);
    expect(inProgressIdx).toBeLessThan(readyIdx);
  });

  it("prints a resume message when an in_progress task is found", () => {
    expect(content).toContain("Resuming interrupted task");
  });

  it("routes in_progress tasks through the Step 2 orphan check", () => {
    expect(content).toContain("orphan check");
  });
});

describe("Step 4 — stale bundle branch detection", () => {
  it("checks --state merged before entering the bundled-task path", () => {
    // The merged-PR check must appear BEFORE the bundled worktree add command
    const mergedCheckIdx = content.indexOf("--state merged");
    const bundledWorktreeIdx = content.indexOf("--track -b {branch}");
    expect(mergedCheckIdx).toBeGreaterThan(-1);
    expect(bundledWorktreeIdx).toBeGreaterThan(-1);
    expect(mergedCheckIdx).toBeLessThan(bundledWorktreeIdx);
  });

  it("when merged PR found: prints a warning with the PR number", () => {
    // The warning message must reference the PR number and describe the action
    const hasMergedWarning =
      content.includes("merged PR") &&
      (content.includes("#{number}") ||
        content.includes("#number") ||
        content.includes("PR number") ||
        content.includes("stale"));
    expect(hasMergedWarning).toBe(true);
  });

  it("when merged PR found: deletes the remote branch before starting fresh", () => {
    // Must include the branch deletion command in the stale-branch guard path
    const hasDeleteAfterMerged =
      content.includes("git push origin --delete {branch}") &&
      content.includes("--state merged");
    expect(hasDeleteAfterMerged).toBe(true);
  });

  it("when no merged PR: original bundled flow (track origin/{branch}) is unchanged", () => {
    // The track origin/{branch} flow must still exist in the doc
    expect(content).toContain("origin/{branch} --track -b {branch}");
  });

  it("merged-PR check derives --repo from git remote (CWD is workspace, not the target repo)", () => {
    // Without --repo, gh resolves against the workspace remote and silently fails.
    // The check must derive the repo slug from git remote get-url and pass it as --repo.
    expect(content).toContain('--repo "$GH_REPO"');
    expect(content).toContain("remote get-url origin");
  });
});

describe("execution metrics — PATCH task columns (replaces metrics.jsonl)", () => {
  it("does not write a metrics.jsonl file during execution", () => {
    // MME-5.1 removed the JSONL pipeline; MME-5.2 must not reintroduce it.
    expect(content).not.toContain("metrics.jsonl");
  });

  it("Step 6 PATCHes the simplify columns after the simplify pass", () => {
    const idx = content.indexOf("Persist simplify metrics");
    expect(idx).toBeGreaterThan(-1);
    const block = content.slice(idx, idx + 1500);
    for (const field of [
      "simplifyTotal",
      "simplifyDry",
      "simplifyDeadCode",
      "simplifyNaming",
      "simplifyComplexity",
      "simplifyConsistency",
    ]) {
      expect(block).toContain(field);
    }
    expect(block).toContain("/tasks/{id}");
  });

  it("Step 10a PATCHes the CI outcome columns after CI resolves", () => {
    const idx = content.indexOf("Persist CI Outcome");
    expect(idx).toBeGreaterThan(-1);
    const block = content.slice(idx, idx + 800);
    expect(block).toContain("ciFixAttempts");
    expect(block).toContain("metadata");
  });

  it("Step 10b PATCHes the completion columns (coverage, effort, tokens, cost)", () => {
    const idx = content.indexOf("Persist Execution Metrics");
    expect(idx).toBeGreaterThan(-1);
    const block = content.slice(idx);
    for (const field of [
      "coverageDelta",
      "effortLevel",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "costUsd",
    ]) {
      expect(block).toContain(field);
    }
  });

  it("every execution-metric PATCH is fire-and-forget (warns, never aborts)", () => {
    // Each PATCH must swallow failures and continue rather than abort the task.
    const warnings = content.match(/\|\| echo "⚠ PATCH [^"]*— continuing"/g) ?? [];
    // simplify + CI outcome + execution metrics = at least three guarded PATCH calls.
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("declares the fire-and-forget convention for execution-metric writes", () => {
    expect(content).toContain("Fire-and-forget convention");
  });
});
