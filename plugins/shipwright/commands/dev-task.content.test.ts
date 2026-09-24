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
    // The old bare self-scan (`?status=in_progress&assignee=$SHIPWRIGHT_AGENT_ID`, unscoped
    // to any specific task) must be gone. The Same-Branch Sibling Check's targeted
    // `?branch={branch}&status=in_progress` lookup is a different, legitimate query and is
    // not banned by this guard.
    expect(content).not.toContain("tasks?status=in_progress&assignee=$SHIPWRIGHT_AGENT_ID");
    expect(content).not.toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress"');
    expect(content).not.toContain("Resuming interrupted task");
  });

  it("in_progress status skips straight to Step 3 — recovery now happens unconditionally in Step 4's reality check, not a status-gated orphan check", () => {
    // The old status-gated "Step 2 Orphan Check" mechanism is retired (DOH-1.1) — superseded
    // by the unconditional Branch/PR Reality Check in Step 4.
    expect(content).not.toMatch(/proceed\s+straight\s+to\s+Step 2's Orphan Check/i);
    expect(content).not.toContain("### Orphan Check (prior session recovery)");
    expect(content).toMatch(/skip\s+Step 2's claim[\s\S]*?then proceed to Step 3/i);
  });

  it("in_progress path is explicitly routed through the Same-Branch Sibling Check before Step 3", () => {
    // The in_progress bullet must not just skip to Step 3 — it must pass through the
    // Same-Branch Sibling Check first, or a resumed task never runs that check.
    const inProgressBulletMatch = content.match(
      /\*\*Found, `status == "in_progress"`\*\*:[\s\S]*?(?=\n- \*\*Found)/,
    );
    expect(inProgressBulletMatch).not.toBeNull();
    const bullet = inProgressBulletMatch?.[0];
    expect(bullet).toMatch(/Same-Branch Sibling Check/i);
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

describe("dev-task.md Step 10a — PATCH status check", () => {
  const getStep10aSection = () => {
    const step10aIdx = content.indexOf("### 10a. Update Queue");
    expect(step10aIdx).toBeGreaterThan(-1);
    const step10dIdx = content.indexOf("### 10d. Print Handoff");
    expect(step10dIdx).toBeGreaterThan(step10aIdx);
    return content.slice(step10aIdx, step10dIdx);
  };

  it("captures the HTTP status code of the PATCH call (mirrors Step 2's claim pattern)", () => {
    const section = getStep10aSection();
    expect(section).toContain("%{http_code}");
    expect(section).toMatch(/PATCH_CODE=\$\(curl/);
  });

  it("writes the PATCH response body to a temp file instead of piping straight to jq", () => {
    const section = getStep10aSection();
    expect(section).toMatch(/-o \/tmp\/task_patch_10a\.json/);
  });

  it("still PATCHes the same status/pr/simplify/coverage/model fields unchanged", () => {
    const section = getStep10aSection();
    expect(section).toContain('\\"status\\": \\"pr_open\\"');
    expect(section).toContain('\\"pr\\": {pr_number}');
    expect(section).toContain('\\"prCreatedAt\\": \\"$PR_CREATED_AT\\"');
    expect(section).toContain('\\"ciFixAttempts\\": {ci_attempt}');
    expect(section).toContain('\\"simplifyTotal\\": {simplify_total}');
    expect(section).toContain('\\"simplifyDry\\": {simplify_dry}');
    expect(section).toContain('\\"simplifyDeadCode\\": {simplify_dead_code}');
    expect(section).toContain('\\"simplifyNaming\\": {simplify_naming}');
    expect(section).toContain('\\"simplifyComplexity\\": {simplify_complexity}');
    expect(section).toContain('\\"simplifyConsistency\\": {simplify_consistency}');
    expect(section).toContain('\\"coverageDelta\\": {coverage_delta}');
    expect(section).toContain('\\"model\\": \\"{EFFECTIVE_MODEL}\\"');
  });

  it("branches on a non-2xx status with a clear failure message and halts before the DONE handoff", () => {
    const section = getStep10aSection();
    expect(section).toMatch(/non-2xx/i);
    expect(section).toMatch(/Step 10a PATCH failed/i);
    expect(section).toMatch(/task-store not updated/i);
    expect(section).toMatch(/handoff aborted/i);
    expect(section).toMatch(/do not proceed to Step 10d/i);
  });

  it("prints the successful response on a 2xx status", () => {
    const section = getStep10aSection();
    expect(section).toMatch(/jq \. \/tmp\/task_patch_10a\.json/);
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

describe("Step 1 — same-branch sibling ordering check (bundled-task deferral)", () => {
  it("adds a Same-Branch Sibling Check section after branch validation and before the TASK banner", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);

    const branchValidationIdx = content.indexOf("**Validate required fields.**");
    const bannerIdx = content.indexOf("TASK: {id}");
    expect(branchValidationIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(branchValidationIdx).toBeLessThan(siblingCheckIdx);
    expect(siblingCheckIdx).toBeLessThan(bannerIdx);
  });

  it("runs before Step 2's claim, avoiding a wasted claim-then-release cycle", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(siblingCheckIdx).toBeLessThan(claimIdx);
  });

  it("queries the task store for other in_progress tasks on the same branch", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 2500);
    expect(section).toContain("/tasks?branch={branch}&status=in_progress");
  });

  it("excludes the current task's own id from the sibling results", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 2500);
    expect(section).toMatch(/exclude.{0,60}own.{0,10}\{id\}|own.{0,10}\{id\}.{0,60}not a\s+sibling/is);
  });

  it("computes sibling freshness using the 65-minute claim TTL, mirroring the stale-claim reaper's two-case formula", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 2500);
    expect(section).toContain("DEFAULT_CLAIM_TTL_MS");
    expect(section).toContain("lib/claim-ttl.ts");
    expect(section).toMatch(/65.{0,10}minute/i);
    expect(section).toMatch(/heartbeatAt.{0,80}within the last 65 minutes/is);
    expect(section).toMatch(/heartbeatAt is null.{0,80}claimedAt.{0,80}within the last 65 minutes/is);
  });

  it("when a sibling is fresh: releases this task's own claim and stops silently, without proceeding", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 3500);
    expect(section).toMatch(/if any sibling is fresh/i);
    expect(section).toContain("/tasks/{id}/release");
    const releaseIdx = section.indexOf("/tasks/{id}/release");
    const before = section.slice(Math.max(0, releaseIdx - 200), releaseIdx);
    expect(before).toMatch(/-X POST/);
    expect(section).toContain("[silent]");
  });

  it("when a sibling is fresh: tags the defer with a namespaced skip-reason marker before [silent], exempting it from the HITL auto-block skip counter (BBE-1.2)", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 3500);
    expect(section).toContain(
      "[skip-reason:dev-task:deferred:same-branch-sibling-busy:{branch}]",
    );
    const skipReasonIdx = section.indexOf(
      "[skip-reason:dev-task:deferred:same-branch-sibling-busy:{branch}]",
    );
    const silentIdx = section.indexOf("[silent]");
    expect(silentIdx).toBeGreaterThan(-1);
    expect(skipReasonIdx).toBeLessThan(silentIdx);
  });

  it("when no sibling is fresh (none exist, or all stale): proceeds normally — no behavior change for genuinely orphaned/stale work", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 4000);
    expect(section).toMatch(/if no sibling is fresh/i);
    expect(section).toMatch(/proceed(s|ing)? normally/i);
    expect(section).toMatch(/Branch\/PR Reality Check.{0,120}unchanged|unchanged.{0,120}Branch\/PR Reality Check/is);
  });

  it("applies regardless of this task's own status (pending or resumed in_progress)", () => {
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(siblingCheckIdx, siblingCheckIdx + 1000);
    expect(section).toMatch(/regardless of this task's own status/i);
  });
});

describe("dev-task.md Step 1 — Dependency Check (pending tasks only)", () => {
  it("tags an unsatisfied dependency defer with [skip-reason:dev-task:deferred:dependency-unsatisfied:{dep-id}] before [silent]", () => {
    const depCheckIdx = content.indexOf("### Dependency Check (pending tasks only)");
    expect(depCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(depCheckIdx, depCheckIdx + 2500);
    expect(section).toContain(
      "[skip-reason:dev-task:deferred:dependency-unsatisfied:{dep-id}]",
    );
    const skipReasonIdx = section.indexOf(
      "[skip-reason:dev-task:deferred:dependency-unsatisfied:{dep-id}]",
    );
    const silentIdx = section.indexOf("[silent]");
    expect(silentIdx).toBeGreaterThan(-1);
    expect(skipReasonIdx).toBeLessThan(silentIdx);
  });

  it("names the specific unsatisfied dependency id in the skip-reason tag", () => {
    const depCheckIdx = content.indexOf("### Dependency Check (pending tasks only)");
    expect(depCheckIdx).toBeGreaterThan(-1);
    const section = content.slice(depCheckIdx, depCheckIdx + 2500);
    // Verify the prose mentions interpolating the dep-id
    expect(section).toMatch(/interpolating.{0,60}(first )?unsatisf/is);
    expect(section).toMatch(/dependency.{0,40}id|dep-id/is);
  });
});

describe("dev-task.md 0b — docs-first toolchain discovery + per-repo cache (TDF-1.1)", () => {
  it("checks the cache before doing any fresh detection", () => {
    const stepIdx = content.indexOf("### 0b. Detect Project Toolchain");
    expect(stepIdx).toBeGreaterThan(-1);
    const section = content.slice(stepIdx, stepIdx + 2000);
    expect(section).toMatch(/\*\*Check the cache\.\*\*/i);
    expect(section).toContain("state/toolchain-cache/{repo-slug}.json");
  });

  it("reads CLAUDE.md and docs/ai-docs before falling back to config-file scanning", () => {
    const stepIdx = content.indexOf("### 0b. Detect Project Toolchain");
    const section = content.slice(stepIdx, stepIdx + 2000);
    expect(section).toMatch(/\*\*Docs-first discovery\*\*/i);
    expect(section).toMatch(/CLAUDE\.md.{0,60}docs\/\*\.md.{0,20}ai-docs\/\*\.md/is);
    expect(section).toMatch(/\*\*Config-file fallback\*\*/i);
  });

  it("does not reference the old single shared cache file", () => {
    expect(content).not.toContain("state/toolchain-cache.json");
  });

  it("stores a tests object for multi-layer test commands alongside the single test command", () => {
    const stepIdx = content.indexOf("### 0b. Detect Project Toolchain");
    const section = content.slice(stepIdx, stepIdx + 2000);
    expect(section).toMatch(/\*\*tests\*\*/i);
    expect(section).toMatch(/optional.*object.*layer/i);
  });
});

describe("toolchain-patterns.md — cache schema includes tests object for multi-layer test commands", () => {
  it("defines a tests field in the cache schema", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const schemaIdx = referencesContent.indexOf('"commands"');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaSection = referencesContent.slice(schemaIdx, schemaIdx + 500);
    expect(schemaSection).toContain('"tests"');
  });

  it("documents multi-layer test detection", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");
    expect(referencesContent).toContain("### Multi-Layer Test Detection");
    expect(referencesContent).toMatch(/keys are free-form/i);
  });
});

describe("toolchain-patterns.md — cache schema includes lintScoped for diff-scoped lint detection (LSC-1.1)", () => {
  it("defines a lintScoped field in the cache schema", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const schemaIdx = referencesContent.indexOf('"commands"');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaSection = referencesContent.slice(schemaIdx, schemaIdx + 500);
    expect(schemaSection).toContain('"lintScoped"');
  });

  it("documents lintScoped as omitted (never null) when no scoped command is available", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const fieldIdx = referencesContent.indexOf("**`lintScoped`**");
    expect(fieldIdx).toBeGreaterThan(-1);
    const fieldSection = referencesContent.slice(fieldIdx, fieldIdx + 500);
    expect(fieldSection).toMatch(/omit/i);
    expect(fieldSection).toMatch(/never.{0,20}null/i);
  });

  it("documents the Turborepo scoped-lint detection rule", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("turbo.json");
    expect(referencesContent).toContain("turbo lint --filter=");
  });

  it("documents the Nx scoped-lint detection rule", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("nx.json");
    expect(referencesContent).toContain("nx affected --target=lint --base=");
  });

  it("documents the pnpm workspaces scoped-lint detection rule", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("pnpm-workspace.yaml");
    expect(referencesContent).toMatch(/pnpm --filter "\.\.\.\[\{base\}\]" lint/);
  });

  it("documents the generic eslint changed-files fallback for no monorepo tool detected", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const sectionIdx = referencesContent.indexOf("### Scoped Lint Detection");
    expect(sectionIdx).toBeGreaterThan(-1);
    const section = referencesContent.slice(sectionIdx, sectionIdx + 2000);
    expect(section).toMatch(/no monorepo tool/i);
    expect(section).toMatch(/eslint/i);
    expect(section).toMatch(/changed/i);
  });
});

describe("toolchain-patterns.md — fingerprint path list covers task-runner/version-manager config (CPF-review-2242)", () => {
  it("includes Taskfile.yml, justfile/Justfile, and mise.toml/.mise.toml alongside the other fingerprinted paths", () => {
    const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const fingerprintIdx = referencesContent.indexOf("git -C {repo-dir} log -1 --format=%H --");
    expect(fingerprintIdx).toBeGreaterThan(-1);
    const fingerprintLine = referencesContent.slice(fingerprintIdx, referencesContent.indexOf("\n", fingerprintIdx));

    expect(fingerprintLine).toContain("Taskfile.yml");
    expect(fingerprintLine).toContain("justfile");
    expect(fingerprintLine).toContain("Justfile");
    expect(fingerprintLine).toContain("mise.toml");
    expect(fingerprintLine).toContain(".mise.toml");
  });
});

describe("dev-task.md Step 5c — BLOCKED dead-end PATCHes task status (BHE-1.2)", () => {
  it("PATCHes status:'blocked' with a blockedReason when the model-upgrade ladder is exhausted and the blocker is a genuine dead end", () => {
    const step5cIdx = content.indexOf("### 5c. Handle Subagent Status");
    expect(step5cIdx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5cIdx + 2500);

    expect(section).toContain('"$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}"');
    expect(section).toMatch(/-X PATCH/);
    expect(section).toMatch(/-d '\{"status": "blocked", "blockedReason": "[a-z_]+"\}'/);
  });

  it("uses the same curl shape as Steps 1/7/9/9b.5 (curl -sf -X PATCH ... | jq .)", () => {
    const step5cIdx = content.indexOf("### 5c. Handle Subagent Status");
    expect(step5cIdx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5cIdx + 2500);

    expect(section).toContain("curl -sf -X PATCH -H \"Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN\"");
    expect(section).toContain('-H "Content-Type: application/json"');
    expect(section).toMatch(/\| jq \./);
  });

  it("does NOT fire the blocked-status PATCH for the context/size/plan cases the step already knows how to resolve", () => {
    const step5cIdx = content.indexOf("### 5c. Handle Subagent Status");
    expect(step5cIdx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5cIdx + 2500);

    // The three self-correcting branches (context, too-large, wrong-plan) must appear
    // BEFORE the blocked-status PATCH, and the PATCH must be scoped to the remaining
    // dead-end case only — not interleaved into each resolvable branch.
    const contextIdx = section.search(/context problem, provide more context/i);
    const tooLargeIdx = section.search(/task is too large, break it into smaller sub-tasks/i);
    const planIdx = section.search(/plan is wrong, escalate to the user/i);
    const patchIdx = section.search(/-X PATCH/);

    expect(contextIdx).toBeGreaterThan(-1);
    expect(tooLargeIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(patchIdx);
    expect(tooLargeIdx).toBeLessThan(patchIdx);
    expect(planIdx).toBeLessThan(patchIdx);
  });

  it("does not comment on or close a PR — Step 5c runs before Step 9 (PR creation), so no PR exists yet", () => {
    const step5cIdx = content.indexOf("### 5c. Handle Subagent Status");
    expect(step5cIdx).toBeGreaterThan(-1);
    const section = content.slice(step5cIdx, step5cIdx + 2500);

    expect(section).not.toContain("gh pr comment");
    expect(section).not.toContain("gh pr close");
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
    const section = content.slice(realityCheckIdx, realityCheckIdx + 6000);
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
    const section = content.slice(realityCheckIdx, realityCheckIdx + 6000);
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

describe("dev-task.md — Step 6 principles override + security domain", () => {
  function getStep6Section(): string {
    const step6Idx = content.indexOf("## Step 6: Simplify");
    expect(step6Idx).toBeGreaterThan(-1);
    const step65Idx = content.indexOf("## Step 6.5:", step6Idx);
    expect(step65Idx).toBeGreaterThan(step6Idx);
    return content.slice(step6Idx, step65Idx);
  }

  it("checks for a project-level override at .claude/shipwright/principles.md before falling back to the plugin default", () => {
    const section = getStep6Section();
    expect(section).toContain(".claude/shipwright/principles.md");
    expect(section).toContain("plugins/shipwright/references/principles.md");

    const overrideIdx = section.indexOf(".claude/shipwright/principles.md");
    const fallbackIdx = section.indexOf("plugins/shipwright/references/principles.md");
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(fallbackIdx);
  });

  it("cites the architecture, testing, and security domains in the Step 6 preamble", () => {
    const section = getStep6Section();
    expect(section).toMatch(/`architecture`/);
    expect(section).toMatch(/`testing`/);
    expect(section).toMatch(/`security`/);
  });

  it("keeps the existing architecture_layering and t* example callouts, and adds a security_* example callout", () => {
    const section = getStep6Section();
    expect(section).toContain("architecture_layering");
    expect(section).toMatch(/`t\*`/);
    expect(section).toMatch(/security_[a-z_]+/);
  });
});

describe("dev-task.md — ScheduleWakeup/backgrounding prohibition guardrail (SWG-1.1)", () => {
  function getStep8Section(): string {
    const step8Idx = content.indexOf("## Step 8: Pre-Ship Checks");
    expect(step8Idx).toBeGreaterThan(-1);
    const step85Idx = content.indexOf("## Step 8.5:", step8Idx);
    expect(step85Idx).toBeGreaterThan(step8Idx);
    return content.slice(step8Idx, step85Idx);
  }

  function getStep9b2Section(): string {
    const step9b2Idx = content.indexOf("### 9b.2. Wait for Checks");
    expect(step9b2Idx).toBeGreaterThan(-1);
    const step9b3Idx = content.indexOf("### 9b.3.", step9b2Idx);
    expect(step9b3Idx).toBeGreaterThan(step9b2Idx);
    return content.slice(step9b2Idx, step9b3Idx);
  }

  it("Step 8 (Pre-Ship Checks) states long-running validation/test commands must run synchronously or backgrounded-and-polled within the same session", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toContain("synchronously");
    expect(lower).toContain("within this same session");
  });

  it("Step 8 does NOT contain the literal string 'ScheduleWakeup'", () => {
    const section = getStep8Section();
    expect(section).not.toContain("ScheduleWakeup");
  });

  it("Step 8's guardrail prohibits handing the wait off via a scheduled wakeup mechanism", () => {
    const section = getStep8Section();
    expect(section.toLowerCase().replace(/\s+/g, " ")).toContain("scheduled wakeup mechanism");
  });

  it("Step 9b.2 (Wait for Checks) states the 30s/10-min poll must run as a blocking loop within the same Bash invocation chain", () => {
    const section = getStep9b2Section();
    expect(section).toContain("chained in-Bash sleep loop");
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toContain("shell-level loop inside a single bash tool call");
    expect(lower).toContain("chain additional bash calls");
  });

  it("Step 9b.2 does NOT contain the literal string 'ScheduleWakeup'", () => {
    const section = getStep9b2Section();
    expect(section).not.toContain("ScheduleWakeup");
  });

  it("Step 9b.2's guardrail prohibits handing the wait off via a scheduled wakeup mechanism", () => {
    const section = getStep9b2Section();
    expect(section.toLowerCase().replace(/\s+/g, " ")).toContain("scheduled wakeup mechanism");
  });

  it("preserves the existing 30-second poll interval and 10-minute budget wording in Step 9b.2", () => {
    const section = getStep9b2Section();
    expect(section).toContain("30 seconds");
    expect(section).toContain("10 minutes");
  });

  it("Step 8 explains the claim-heartbeat mechanism: a resumed session stops the task's claim heartbeat", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/heartbeat|heart.{0,20}beat/);
  });

  it("Step 8 mentions the StaleClaimReaper (or 'stale claim reaper') that reclaims abandoned claims", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/stale.{0,40}claim.{0,40}reaper|reaper.{0,40}stale.{0,40}claim/);
  });

  it("Step 8 cites the ~65-minute claim TTL after which a stale claim is reclaimed", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/65.{0,10}minute|~65|claim.{0,60}ttl/i);
  });

  it("Step 8 explains that a stale-claim reclaim causes a context-free re-bootstrap on the next cron tick", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/context.{0,10}free|reclaim.*re.?dispatch|re.?bootstrap/i);
  });

  it("Step 9b.2 explains the claim-heartbeat mechanism: a resumed session stops the task's claim heartbeat", () => {
    const section = getStep9b2Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/heartbeat|heart.{0,20}beat/);
  });

  it("Step 9b.2 mentions the StaleClaimReaper (or 'stale claim reaper') that reclaims abandoned claims", () => {
    const section = getStep9b2Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/stale.{0,40}claim.{0,40}reaper|reaper.{0,40}stale.{0,40}claim/);
  });

  it("Step 9b.2 cites the ~65-minute claim TTL after which a stale claim is reclaimed", () => {
    const section = getStep9b2Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/65.{0,10}minute|~65|claim.{0,60}ttl/i);
  });

  it("Step 9b.2 explains that a stale-claim reclaim causes a context-free re-bootstrap on the next cron tick", () => {
    const section = getStep9b2Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/context.{0,10}free|reclaim.*re.?dispatch|re.?bootstrap/i);
  });
});

describe("dev-task.md Step 1 — repo-slug derivation for local paths (PRF-1.4)", () => {
  it("derives {repo-slug} in Step 1, immediately after the task fetch and before the Same-Branch Sibling Check", () => {
    const fetchIdx = content.indexOf('"$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}"');
    expect(fetchIdx).toBeGreaterThan(-1);
    const siblingCheckIdx = content.indexOf("### Same-Branch Sibling Check");
    expect(siblingCheckIdx).toBeGreaterThan(fetchIdx);

    const section = content.slice(fetchIdx, siblingCheckIdx);
    expect(section).toContain("{repo-slug}");
    expect(section).toMatch(/last path segment/i);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in test description, not JS interpolation
  it("no longer uses raw {repo} for ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} style local paths", () => {
    // This exact substring would NOT match {repo-slug} (which has extra chars before the
    // closing brace), so it robustly distinguishes "still raw {repo}" from "now {repo-slug}".
    expect(content.match(/\$\{SHIPWRIGHT_REPO_DIR:-\$HOME\/src\}\/\{repo\}/)).toBeNull();
  });

  it("keeps the Same-Branch Sibling Check's task-store API call scoped by the full {repo} (org/repo) value, unchanged", () => {
    expect(content).toContain(
      '"$SHIPWRIGHT_TASK_STORE_URL/tasks?branch={branch}&status=in_progress&repo={repo}"',
    );
  });

  it("derives GH_REPO from the local checkout using {repo-slug}, not {repo}", () => {
    expect(content).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter-expansion in asserted dev-task command text, not JS interpolation
      "git -C ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug} remote get-url origin",
    );
  });

  it("constructs worktree paths using {repo-slug}-{branch-slug}", () => {
    expect(content).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell worktree-path placeholder in asserted dev-task text, not JS interpolation
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo-slug}-{branch-slug}",
    );
  });
});

describe("dev-task.md — worktree add/remove absolute-fallback regression guard (T-085)", () => {
  // Matches every `git -C ... worktree add/remove ...` invocation, in full, on one line —
  // mirrors the file's actual style (see lines ~390/411/437/443/448). Deliberately requires
  // the literal `git -C` prefix so it does NOT match the unrelated prose line
  // "`worktree add {worktree-path} {branch}`" (no `git -C`, no leading dash-C path).
  const WORKTREE_INVOCATION_RE = /git -C \S+ worktree (?:add|remove) \S+[^\n]*/g;

  const getWorktreeInvocations = () => content.match(WORKTREE_INVOCATION_RE) ?? [];

  // A bare relative default for either fallback var — e.g. ${SHIPWRIGHT_REPO_DIR:-repos} or
  // ${SHIPWRIGHT_WORKTREE_DIR:-worktrees} — the exact class of bug PR #3545 fixed. Any
  // ${VAR:-DEFAULT} where DEFAULT does not start with an absolute path ($HOME/ or /) trips
  // this, regardless of what the relative default text actually says.
  const BARE_RELATIVE_DEFAULT =
    /\$\{(?:SHIPWRIGHT_REPO_DIR|SHIPWRIGHT_WORKTREE_DIR):-(?!\$HOME\/|\/)[^}]*\}/;

  it("finds at least one `git -C ... worktree add/remove ...` invocation to guard (sanity check the regex isn't vacuous)", () => {
    const invocations = getWorktreeInvocations();
    expect(invocations.length).toBeGreaterThan(0);
  });

  it("every worktree add/remove invocation resolves both SHIPWRIGHT_REPO_DIR and SHIPWRIGHT_WORKTREE_DIR via the absolute-fallback form, never a bare relative default", () => {
    const invocations = getWorktreeInvocations();
    for (const invocation of invocations) {
      expect(invocation).not.toMatch(BARE_RELATIVE_DEFAULT);
      // Every invocation's `-C` repo path must resolve via ${SHIPWRIGHT_REPO_DIR:-$HOME/src}.
      expect(invocation).toMatch(/\$\{SHIPWRIGHT_REPO_DIR:-\$HOME\//);
      // Every invocation's worktree-path argument must resolve via
      // ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}.
      expect(invocation).toMatch(/\$\{SHIPWRIGHT_WORKTREE_DIR:-\$HOME\//);
    }
  });
});

describe("dev-task.md Step 1 — PRD-shaped task guard (fallback safety net) (PDR-1.1)", () => {
  const getGuardSection = () => {
    const guardIdx = content.indexOf("### PRD-Shaped Task Guard");
    expect(guardIdx).toBeGreaterThan(-1);
    const dependencyCheckIdx = content.indexOf("### Dependency Check (pending tasks only)");
    expect(dependencyCheckIdx).toBeGreaterThan(guardIdx);
    return { guardIdx, dependencyCheckIdx, section: content.slice(guardIdx, dependencyCheckIdx) };
  };

  it("adds a PRD-Shaped Task Guard section in Step 1 after pending-status validation and before Dependency Check", () => {
    const { guardIdx, dependencyCheckIdx } = getGuardSection();
    const pendingBulletIdx = content.indexOf('**Found, `status == "pending"`**:');
    expect(pendingBulletIdx).toBeGreaterThan(-1);
    // Guard should be after the pending bullet and before Dependency Check
    expect(pendingBulletIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(dependencyCheckIdx);
  });

  it("detects task id prefix: task id matches ^prd-", () => {
    const { section } = getGuardSection();
    expect(section).toMatch(/task.{0,40}id.{0,40}(match|matches).{0,60}\^prd-/i);
  });

  it("detects description prefix: description opens with 'Commit as PRODUCT-SPEC.md and run /shipwright:plan-session'", () => {
    const { section } = getGuardSection();
    expect(section).toContain("Commit as PRODUCT-SPEC.md and run /shipwright:plan-session");
  });

  it("detects branch and criteria: branch === 'main' AND acceptanceCriteria is empty", () => {
    const { section } = getGuardSection();
    expect(section).toMatch(/branch.{0,60}main/i);
    expect(section).toMatch(/acceptanceCriteria.{0,60}empty/i);
  });

  it("stops before the Dependency Check and before claiming (Step 2)", () => {
    const { section: _section } = getGuardSection();
    const claimIdx = content.indexOf("/tasks/{id}/claim");
    const guardIdx = content.indexOf("### PRD-Shaped Task Guard");
    expect(guardIdx).toBeLessThan(claimIdx);
  });

  it("PATCHes the task with exact fields: status:blocked, hitl:true, blockedReason:misrouted_needs_plan_session_not_dev_task", () => {
    const { section } = getGuardSection();
    expect(section).toContain('"status": "blocked"');
    expect(section).toContain('"hitl": true');
    expect(section).toContain('"blockedReason": "misrouted_needs_plan_session_not_dev_task"');
  });

  it("uses curl -X PATCH with the standard Authorization header and Content-Type application/json", () => {
    const { section } = getGuardSection();
    expect(section).toContain("curl -sf -X PATCH");
    expect(section).toContain("-H \"Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN\"");
    expect(section).toContain('-H "Content-Type: application/json"');
  });

  it("includes the curl command targeting the task-store /tasks/{id} endpoint", () => {
    const { section } = getGuardSection();
    expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/{id}");
  });

  it("pipes the PATCH response through jq", () => {
    const { section } = getGuardSection();
    expect(section).toMatch(/\| jq \./);
  });

  it("prints a clear warning message when guard triggers", () => {
    const { section } = getGuardSection();
    expect(section).toMatch(/⚠.*PRD-shaped|Task.{0,40}looks PRD-shaped/i);
    expect(section).toMatch(/blocked|blocked for human/i);
  });

  it("does NOT special-case kind:prd tasks (they are excluded upstream at ?ready=true level)", () => {
    const { section } = getGuardSection();
    expect(section).not.toContain("autonomousPlanSession");
    expect(section).not.toContain('"kind"');
  });
});

describe("dev-task.md — subagent dispatch is foreground, not background (ABD-1.2)", () => {
  it("Step 5b's implementation-subagent dispatch pins run_in_background: false", () => {
    const anchorIdx = content.indexOf("Dispatch a `general-purpose` subagent with this prompt");
    expect(anchorIdx).toBeGreaterThan(-1);
    const section = content.slice(anchorIdx, anchorIdx + 600);
    expect(section).toContain("run_in_background: false");
  });

  it("Step 5b's nested researcher-agent spawn instruction pins run_in_background: false", () => {
    const anchorIdx = content.indexOf("Spawn the shipwright:researcher agent via the Agent tool");
    expect(anchorIdx).toBeGreaterThan(-1);
    const section = content.slice(anchorIdx, anchorIdx + 300);
    expect(section).toContain("run_in_background: false");
  });

  it("Step 6.5's spec compliance subagent dispatch pins run_in_background: false", () => {
    const anchorIdx = content.indexOf("**Dispatch a `general-purpose` subagent** with `model: 'haiku'`");
    expect(anchorIdx).toBeGreaterThan(-1);
    const section = content.slice(anchorIdx, anchorIdx + 300);
    expect(section).toContain("run_in_background: false");
  });

  it("Step 8.5a's docs-refresher agent dispatch pins run_in_background: false", () => {
    const anchorIdx = content.indexOf("Use the Agent tool to dispatch the `shipwright:docs-refresher` agent");
    expect(anchorIdx).toBeGreaterThan(-1);
    const section = content.slice(anchorIdx, anchorIdx + 300);
    expect(section).toContain("run_in_background: false");
  });

  it("Step 9b.3's CI-fix subagent dispatch pins run_in_background: false", () => {
    const anchorIdx = content.indexOf("**Launch fix subagent** using the Agent tool");
    expect(anchorIdx).toBeGreaterThan(-1);
    const section = content.slice(anchorIdx, anchorIdx + 300);
    expect(section).toContain("run_in_background: false");
  });
});

describe("dev-task.md Step 8 — scoped lint wiring (LSC-1.2)", () => {
  const buildAndLintSection = () => {
    const anchorIdx = content.indexOf("### Build & Lint");
    expect(anchorIdx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("## Step 8.5: Auto-Refresh Docs");
    expect(nextSectionIdx).toBeGreaterThan(anchorIdx);
    return content.slice(anchorIdx, nextSectionIdx);
  };

  it("references the lintScoped cache field from the Step 0/0b toolchain cache", () => {
    const section = buildAndLintSection();
    expect(section).toContain("lintScoped");
    expect(section).toMatch(/Step 0\/0b|Step 0b/);
  });

  it("documents running lintScoped in place of the unscoped lint command when present", () => {
    const section = buildAndLintSection();
    expect(section).toMatch(/lintScoped/);
    expect(section).toMatch(/in place of|instead of/i);
  });

  it("documents falling back to the existing unscoped lint command unchanged when lintScoped is absent", () => {
    const section = buildAndLintSection();
    expect(section).toMatch(/absent|not (?:present|populated)|omitted/i);
    expect(section).toMatch(/fall ?back/i);
    expect(section).toMatch(/unchanged/i);
  });

  it("resolves {base}/{head} to the existing main...HEAD diffing convention without new diff-computation logic", () => {
    const section = buildAndLintSection();
    expect(section).toContain("{base}");
    expect(section).toContain("{head}");
    expect(section).toContain("main");
    expect(section).toMatch(/main\.\.\.HEAD/);
  });

  it("documents resolving the priority-4 {changed files} placeholder from git diff --name-only", () => {
    const section = buildAndLintSection();
    expect(section).toContain("{changed files}");
    expect(section).toContain("git diff --name-only main...HEAD");
  });

  it("documents reporting which lint mode (scoped vs. full) ran in the Pre-Ship Checks output", () => {
    const section = buildAndLintSection();
    expect(section).toMatch(/scoped/i);
    expect(section).toMatch(/full/i);
    expect(section).toMatch(/report/i);
  });

  it("no longer contains the old blocking pause-point line — replaced by non-blocking always-proceed wording (LVB-2.1)", () => {
    const section = buildAndLintSection();
    expect(section).not.toContain(
      "**Pause point (conditional):** Only if a check fails and cannot be auto-fixed, stop and let the user resolve.",
    );
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/never block(s|ing)? (proceeding to )?(step 9|push)/);
  });
});

describe("dev-task.md Step 8 — enforced non-blocking verification budgets (LVB-2.1)", () => {
  const getStep8Section = () => {
    const step8Idx = content.indexOf("## Step 8: Pre-Ship Checks");
    expect(step8Idx).toBeGreaterThan(-1);
    const step85Idx = content.indexOf("## Step 8.5:", step8Idx);
    expect(step85Idx).toBeGreaterThan(step8Idx);
    return content.slice(step8Idx, step85Idx);
  };

  it("does not contain the old blocking pause-point line for a failed/unfixable check", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).not.toContain(
      "pause point (conditional): only if a check fails and cannot be auto-fixed, stop and let the user resolve.",
    );
  });

  it("wraps checks in a process-group-aware enforced timeout: setsid + whole-group kill wording, not just 'wrapped in timeout'", () => {
    const section = getStep8Section();
    expect(section).toContain("setsid");
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/process(-| )group/);
    // Must describe killing the whole group (negative-PID / group kill), not merely naming timeout.
    expect(lower).toMatch(/(kill|terminat).{0,60}(whole|entire|-\$|negative).{0,20}(group|pid)|(-\$pid|kill -- -\$)/);
  });

  it("states expiry (timeout) never blocks proceeding to Step 9 (Push & PR)", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/(timeout|expir(y|es|ed)).{0,120}never block/);
  });

  it("states a check FAILURE (not just timeout) also never blocks proceeding, distinguishing this from Step 5's TDD gate", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/fail.{0,120}never block/);
    expect(lower).toContain("step 5");
    expect(lower).toMatch(/only.{0,60}step 5.{0,80}(real|actual) block/);
  });

  it("derives the per-check budget from real recent CI job durations via gh run list, with a documented flat fallback constant", () => {
    const section = getStep8Section();
    expect(section).toContain("gh run list");
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/fallback/);
    expect(lower).toMatch(/\d+[- ]minute/);
  });

  it("records each check's outcome (pass/fail/timeout/skip) for the printed Pre-Ship Checks output", () => {
    const section = getStep8Section();
    const lower = section.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toMatch(/(pass|fail|timeout|skip)[^.]{0,40}(pass|fail|timeout|skip)[^.]{0,40}(pass|fail|timeout|skip)/);
    expect(lower).toMatch(/record|report|print/);
  });

  it("addresses install explicitly as one of the enforced-timeout-wrapped checks", () => {
    const section = getStep8Section();
    expect(section).toMatch(/install/i);
  });
});

describe("dev-task.md Step 0b — lintScoped producer wiring (LSC-1.2)", () => {
  const storeAndCacheSection = () => {
    const anchorIdx = content.indexOf("4. **Store and cache.**");
    expect(anchorIdx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("## Step 2: Mark In-Progress");
    expect(nextSectionIdx).toBeGreaterThan(anchorIdx);
    return content.slice(anchorIdx, nextSectionIdx);
  };

  it("lists lintScoped among the fields written to the toolchain cache", () => {
    const section = storeAndCacheSection();
    expect(section).toContain("**lintScoped**");
  });

  it("points at toolchain-patterns.md's Scoped Lint Detection rules", () => {
    const section = storeAndCacheSection();
    expect(section).toContain("references/toolchain-patterns.md");
    expect(section).toContain("Scoped Lint Detection");
  });

  it("enumerates all four scoped-lint priority signals and their commands", () => {
    const section = storeAndCacheSection();
    expect(section).toContain("turbo.json");
    expect(section).toContain("turbo lint --filter=...[{base}...{head}]");
    expect(section).toContain("nx.json");
    expect(section).toContain("nx affected --target=lint --base={base}");
    expect(section).toContain("pnpm-workspace.yaml");
    expect(section).toContain('pnpm --filter "...[{base}]" lint');
    expect(section).toContain("eslint {changed files}");
  });

  it("instructs storing the template with placeholders unsubstituted for the Step 8 consumer", () => {
    const section = storeAndCacheSection();
    expect(section).toMatch(/unsubstituted/i);
    expect(section).toMatch(/\{changed files\}/);
    expect(section).toMatch(/Build & Lint|Step 8/);
  });

  it("instructs omitting lintScoped entirely rather than writing null when no scoped command exists", () => {
    const section = storeAndCacheSection();
    expect(section).toMatch(/omit `lintScoped` from the cache entirely/i);
    expect(section).toMatch(/never write `null`/i);
  });

  it("keeps the existing unscoped lint cache field alongside lintScoped", () => {
    const section = storeAndCacheSection();
    expect(section).toContain("**lint**");
    expect(section).toContain("**typecheck**");
    expect(section).toContain("**build**");
  });
});
