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

  it("in_progress status skips straight to Step 3 — recovery now happens unconditionally in Step 4's reality check, not a status-gated orphan check", () => {
    // The old status-gated "Step 2 Orphan Check" mechanism is retired (DOH-1.1) — superseded
    // by the unconditional Branch/PR Reality Check in Step 4.
    expect(content).not.toMatch(/proceed\s+straight\s+to\s+Step 2's Orphan Check/i);
    expect(content).not.toContain("### Orphan Check (prior session recovery)");
    expect(content).toMatch(/skip\s+Step 2's claim and proceed directly to Step 3/i);
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

describe("Step 4 — unconditional branch/PR reality check (DOH-1.1)", () => {
  it("runs the reality check before any `git worktree add -b {branch}` invocation, regardless of task-store status", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);

    // Every worktree-add-with-new-branch invocation in Step 4 must come after the
    // reality check header, not before it.
    const worktreeAddIdx = content.indexOf("worktree add");
    expect(worktreeAddIdx).toBeGreaterThan(-1);
    expect(realityCheckIdx).toBeLessThan(worktreeAddIdx);
  });

  it("is not gated on task-store status — checks live git/GitHub state unconditionally", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 2500);
    expect(section).toMatch(/regardless of what task-store status says/i);
  });

  it("checks the local branch, remote branch (git ls-remote --heads origin), and open PR (gh pr list --head, --state open)", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 3000);

    // Local branch check
    expect(section).toMatch(/git -C .*branch --list \{branch\}/);
    // Remote branch check
    expect(section).toContain("git ls-remote --heads origin {branch}");
    // Open PR check with mergeability/CI-relevant fields
    expect(section).toContain("--state open");
    expect(section).toMatch(/gh pr list --head \{branch\}.*--state open.*json number,state,mergeable,mergeStateStatus/);
  });

  it("derives --repo from git remote using the same pattern as the Step 4 stale-bundle-branch check", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 3000);
    expect(section).toContain("remote get-url origin");
    expect(section).toContain('--repo "$GH_REPO"');
  });

  it("complete-and-correct path skips destructive delete and PATCHes the task store to reflect reality", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 5000);
    expect(section).toMatch(/complete and correct/i);
    expect(section).toMatch(/skip(s|ping)? (the )?destructive/i);
    expect(section).toContain(`"$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}"`);
    expect(section).toMatch(/-X PATCH/);
  });

  it("incomplete/stale path closes the PR (if any) and deletes the branch (remote + local) before falling through to fresh worktree creation", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 5500);
    expect(section).toMatch(/incomplete|stale/i);
    expect(section).toContain("gh pr close");
    expect(section).toContain("git push origin --delete {branch}");
    expect(section).toMatch(/git -C .*branch -D \{branch\}/);
  });

  it("incomplete/stale path removes any existing worktree for {branch} before force-deleting the local branch (DOH-1.1 follow-up)", () => {
    // git refuses to force-delete a branch checked out in any worktree — a crashed session
    // can leave `{branch}` checked out in a worktree, so the worktree must be removed first.
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 5500);
    const staleSectionIdx = section.search(/\*\*Incomplete, stale/i);
    expect(staleSectionIdx).toBeGreaterThan(-1);
    const staleSection = section.slice(staleSectionIdx);
    const worktreeRemoveIdx = staleSection.search(/worktree remove/);
    const branchDeleteIdx = staleSection.search(/git -C .*branch -D \{branch\}/);
    expect(worktreeRemoveIdx).toBeGreaterThan(-1);
    expect(branchDeleteIdx).toBeGreaterThan(-1);
    expect(worktreeRemoveIdx).toBeLessThan(branchDeleteIdx);
  });

  it("resume-from-PR path checks CI status before treating an existing PR as complete", () => {
    const realityCheckIdx = content.indexOf("### Branch/PR Reality Check");
    expect(realityCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(realityCheckIdx, realityCheckIdx + 5000);
    expect(section).toMatch(/CI/);
  });

  it("no longer routes an in_progress task's stale branch/PR cleanup through a status-gated Step 2 Orphan Check", () => {
    expect(content).not.toContain("### Orphan Check (prior session recovery)");
    expect(content).not.toMatch(/If the task's current status is already `in_progress`:/);
  });

  it("Step 1 no longer special-cases in_progress status as a distinct branch routing to Step 2's Orphan Check", () => {
    expect(content).not.toMatch(/proceed\s+straight\s+to\s+Step 2's Orphan Check/i);
  });
});
