import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_TASK_MD_PATH = join(import.meta.dir, "dev-task.md");

let content: string;

beforeAll(() => {
  content = readFileSync(DEV_TASK_MD_PATH, "utf-8");
});

describe("dev-task.md — explicit-target-only argument contract", () => {
  it("frontmatter declares argument-hint as required (angle brackets, not optional brackets)", () => {
    const frontmatterEnd = content.indexOf("---", 3);
    const frontmatter = content.slice(0, frontmatterEnd);
    expect(frontmatter).toContain('argument-hint: "<task-id>"');
    expect(frontmatter).not.toContain('argument-hint: "[task-id]"');
  });

  it("states the task-id argument is required in prose", () => {
    expect(content).toMatch(/task-id.{0,40}required|required.{0,40}task-id/is);
  });

  it("no-argument invocation responds [silent] and stops with no task-store queries", () => {
    // The "no arguments -> resume interrupted task / scan ready=true" fallback must be gone.
    expect(content).not.toContain("resume an interrupted task if one exists");
    expect(content).not.toMatch(/no arguments.{0,80}resume/is);
    expect(content).not.toContain("Otherwise (no arguments)");
    expect(content).not.toContain("pick the next ready pending task");
  });

  it("removes the ready-queue scan (GET /tasks?ready=true request) from Step 1 entirely", () => {
    expect(content).not.toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true"');
    expect(content).not.toContain("ready-queue scan");
  });

  it("removes the in_progress resume-check query from Step 1", () => {
    expect(content).not.toContain("status=in_progress");
    expect(content).not.toContain("Resuming interrupted task");
  });

  it("routes an explicit task-id's in_progress status through the Step 2 orphan check", () => {
    expect(content).toMatch(/orphan check/i);
  });
});

describe("dev-task.md Step 1 — explicit task-id fetch, validate, claim", () => {
  it("fetches the task directly via GET /tasks/{task-id} instead of scanning", () => {
    expect(content).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}");
  });

  it("stops with not-found messaging on 404", () => {
    expect(content).toContain("not found");
  });

  it("stops with a status message when status is not pending or in_progress", () => {
    expect(content).toMatch(/status.{0,40}not.{0,10}workable|nothing to do/is);
  });

  it("validates dependency satisfaction for a pending task before claiming", () => {
    expect(content).toMatch(/dependenc(y|ies).{0,120}satisf/is);
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

  it("handles 409 by responding [silent] and stopping — no retry against a different task", () => {
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    expect(claimIdx).toBeGreaterThan(-1);
    const after = content.slice(claimIdx, claimIdx + 1500);
    expect(after).toContain("409");
    expect(after).toContain("[silent]");
    expect(after).not.toMatch(/loop back to Step 1/i);
    expect(after).not.toMatch(/pick(ing)? (the )?next ready task/i);
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
