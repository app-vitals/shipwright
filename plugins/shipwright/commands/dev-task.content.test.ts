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

describe("dev-task.md Step 2 — atomic claim", () => {
  it("no longer marks in-progress via a plain PATCH with a status body", () => {
    // The old flow PATCHed the task with a status:in_progress body to mark it
    // in progress. That specific PATCH invocation must be gone from Step 2 —
    // scoped narrowly so it doesn't clash with Step 1's `?status=in_progress`
    // query string check or other PATCH calls elsewhere in the doc (e.g. blocked).
    expect(content).not.toContain('-d "{\\"status\\": \\"in_progress\\", \\"startedAt\\"');
  });

  it("calls POST /tasks/{id}/claim to atomically claim the task", () => {
    expect(content).toContain("/tasks/{id}/claim");
    // Must be a POST, not a PATCH.
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    const before = content.slice(Math.max(0, claimIdx - 400), claimIdx);
    expect(before).toMatch(/-X POST/);
  });

  it("does not send a JSON body on the claim call (agent token pins claimedBy server-side)", () => {
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    expect(claimIdx).toBeGreaterThan(-1);
    // Look at the surrounding claim command block only, not the whole doc.
    const block = content.slice(Math.max(0, claimIdx - 400), claimIdx + 200);
    expect(block).not.toContain('-d "{\\"claimedBy\\"');
    expect(block).not.toContain("-d '{\"claimedBy\"");
  });

  it("handles 409 by instructing to loop back to Step 1 and pick the next ready task", () => {
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    expect(claimIdx).toBeGreaterThan(-1);
    const after = content.slice(claimIdx, claimIdx + 1500);
    expect(after).toContain("409");
    expect(after).toMatch(/Step 1/);
  });

  it("captures the HTTP status code of the claim call (mirrors review.md's claim pattern)", () => {
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    const before = content.slice(Math.max(0, claimIdx - 400), claimIdx);
    expect(before).toContain("%{http_code}");
  });

  it("does not separately PATCH startedAt after claiming (claim() sets it atomically)", () => {
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    const after = content.slice(claimIdx, claimIdx + 1500);
    expect(after).not.toContain("startedAt");
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
