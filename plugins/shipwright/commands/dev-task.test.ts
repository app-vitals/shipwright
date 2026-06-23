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

describe("dev-task.md Step 10b — test_layers block in metrics emit", () => {
  it('emit line includes "test_layers" key', () => {
    expect(content).toContain("test_layers");
  });

  it('emit line includes "measured" key', () => {
    expect(content).toContain('"measured"');
  });

  it('emit line includes "planned" key', () => {
    expect(content).toContain('"planned"');
  });

  it('emit line includes "drift" key', () => {
    expect(content).toContain('"drift"');
  });

  it("contains instruction that every field must be present even when no test changes", () => {
    const hasEveryField =
      content.includes("every field") ||
      content.includes("Every field") ||
      content.includes("all sub-keys") ||
      content.includes("no test changes");
    expect(hasEveryField).toBe(true);
  });

  it('emit line includes "coverage_per_layer_reason" key for recording why coverage is null', () => {
    expect(content).toContain("coverage_per_layer_reason");
  });

  it("states that /review Step 13 enrichment is unaffected by the test_layers block", () => {
    const hasReviewNote =
      content.includes("review") &&
      (content.includes("unaffected") ||
        content.includes("enrich") ||
        content.includes("Step 13"));
    expect(hasReviewNote).toBe(true);
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

describe("dev-task.md Step 10b — test layer conformance flagging", () => {
  it("states that conformance deviations are advisory and never block", () => {
    const hasAdvisoryNeverBlocks =
      content.includes("advisory") &&
      (content.includes("never") ||
        content.includes("never blocks") ||
        content.includes("never causes"));
    expect(hasAdvisoryNeverBlocks).toBe(true);
  });
  it('emit line includes "conformance" key', () => {
    expect(content).toContain('"conformance"');
  });
  it("states that with no test-system.md, conformance was not checked", () => {
    const hasNotChecked =
      content.includes("not checked") ||
      content.includes("checked: false") ||
      content.includes('"checked": false');
    expect(hasNotChecked).toBe(true);
  });

  it("gates the entire TLM block on test-system.md presence, emitting configured:false when absent", () => {
    const hasConfiguredFalse =
      content.includes('"configured":false') ||
      content.includes('"configured": false') ||
      content.includes("configured:false");
    expect(hasConfiguredFalse).toBe(true);
  });

  it("skips measurement when test-system.md is absent rather than using language-specific defaults", () => {
    const hasSkipInstruction =
      content.includes("not configured") ||
      (content.includes("defaults") &&
        (content.includes("skip") || content.includes("Skip")));
    expect(hasSkipInstruction).toBe(true);
  });
});
