import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UNBLOCK_MD_PATH = join(import.meta.dir, "unblock.md");

let content: string;

beforeAll(() => {
  content = readFileSync(UNBLOCK_MD_PATH, "utf-8");
});

describe("unblock.md — frontmatter and interactive contract (HSR-2.5)", () => {
  it("has a description and argument-hint in frontmatter", () => {
    const frontmatterEnd = content.indexOf("---", 3);
    const frontmatter = content.slice(0, frontmatterEnd);
    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("argument-hint:");
  });

  it("states the command runs interactively, not autonomously", () => {
    expect(content).toContain("This command runs interactively");
  });

  it("points to /shipwright:task-store for setup when env vars are missing", () => {
    expect(content).toContain("SHIPWRIGHT_TASK_STORE_URL");
    expect(content).toContain("SHIPWRIGHT_TASK_STORE_TOKEN");
    expect(content).toContain("/shipwright:task-store");
  });

  it("does not self-run as an autonomous shipwright-loop phase (no candidate-provider integration)", () => {
    const lower = content.toLowerCase();
    expect(lower).not.toContain("loop-orchestrator");
    expect(lower).not.toContain("candidate provider");
  });
});

describe("unblock.md — discovery (AC1)", () => {
  it("queries GET /tasks?state=blocked", () => {
    expect(content).toContain("/tasks?state=blocked");
  });

  it("queries GET /prs?blocked=true", () => {
    expect(content).toContain("/prs?blocked=true");
  });

  it("documents that an omitted repo filter discovers across all repos in the token's scope", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("repo");
    const hasScopeLanguage =
      lower.includes("token's scope") ||
      lower.includes("token scope") ||
      lower.includes("all repos");
    expect(hasScopeLanguage).toBe(true);
  });

  it("notes blockedBy is dependency-blocking context, distinct from escalation blockedReason", () => {
    expect(content).toContain("blockedBy");
    const lower = content.toLowerCase();
    expect(lower).toContain("dependency");
  });

  it("dedupes blocked PRs via a live GET /tasks?repo=&pr= lookup, not PullRequest.taskId", () => {
    expect(content).toMatch(/\/tasks\?repo=.*&pr=/);
    const lower = content.toLowerCase();
    expect(lower).toContain("do not dedupe on `pullrequest.taskid`");
  });

  it("documents that a PR can have multiple linked tasks and each is triaged once per match", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("more than one");
    expect(lower).toContain("bundle");
    expect(lower).toContain("not one collapsed item");
  });

  it("still treats a PR with zero linked tasks as a PR-only record", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("zero");
    expect(lower).toContain("pr-only record with no linked task");
  });
});

describe("unblock.md — phase inference (AC2)", () => {
  const devTaskReasons = [
    "implementation_blocked_after_model_escalation",
    "requirements_not_met",
    "pr_creation_failed",
    "ci_max_retries_exhausted",
  ];
  const patchReasons = [
    "merge-conflict",
    "second-round disagreement",
    "structurally unfixable",
    "review-finding fix blocked",
    "CI-fix blocked",
  ];
  const mergeReasons = [
    "Post-merge CI failed",
    "Squash merge failed",
    "Merge blocked by branch protection",
  ];

  it("mentions every dev-task.md blockedReason pattern", () => {
    for (const reason of devTaskReasons) {
      expect(content).toContain(reason);
    }
  });

  it("mentions every patch.md blockedReason pattern", () => {
    for (const reason of patchReasons) {
      expect(content).toContain(reason);
    }
  });

  it("maps the main_red: blockedReason to the patch phase with confirm-main-green retry guidance", () => {
    const row = content
      .split("\n")
      .find((l) => l.startsWith("|") && l.includes("`main_red:`"));
    expect(row).toBeDefined();
    expect(row).toContain("**patch**");
    expect(content).toMatch(/confirm the base branch is\s+green again/);
    expect(content).toMatch(/refresh CI/);
  });

  it("mentions every merge.md blockedReason pattern", () => {
    for (const reason of mergeReasons) {
      expect(content).toContain(reason);
    }
  });

  it("mentions the recordSkip auto-block pattern (Auto-blocked after)", () => {
    expect(content).toContain("Auto-blocked after");
  });

  it("distinguishes the task-side skip-count spin-detection variant from the PR-side CI-failure-streak variant", () => {
    expect(content).toContain("consecutive skips");
    expect(content).toContain("consecutive patch cycles hitting the same CI failure");
    expect(content).toContain("consecutiveCiFailureCount");
    expect(content).toContain("skipCount");
  });

  it("notes POST /prs/:id/unblock resets the PR-side consecutiveCiFailureCount streak", () => {
    expect(content).toContain("POST /prs/:id/unblock");
    expect(content).toContain("resets the streak counter");
  });

  it("attributes dev-task reasons to the dev-task phase, patch reasons to patch, merge reasons to merge", () => {
    expect(content).toMatch(/dev-task/);
    expect(content).toMatch(/patch/);
    expect(content).toMatch(/\*\*merge\*\*/);
    expect(content).not.toContain("canary_blocked");
  });

  it("handles an unrecognized blockedReason as unknown origin phase rather than guessing", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("unknown");
  });
});

describe("unblock.md — retry logic (AC3)", () => {
  it("retries a task with a single POST /tasks/:id/unblock call and documents the optional `to` override", () => {
    expect(content).toMatch(/\/tasks\/\$TASK_ID\/unblock/);
    expect(content).toContain('"to"');
    expect(content).toContain("409");
  });

  it("retries a PR-only record with a single POST /prs/:id/unblock call", () => {
    expect(content).toMatch(/\/prs\/\$PR_ID\/unblock/);
  });

  it("has removed the hand-written pr_open PATCH branch, the PATCH /prs blocked:false retry, and the 6d skip/reset step", () => {
    expect(content).not.toMatch(/"status": "pr_open"/);
    expect(content).not.toMatch(/blocked.{0,5}: false/);
    expect(content).not.toContain("/skip/reset");
    expect(content).not.toContain("/tasks/$TASK_ID/release");
    expect(content).not.toContain("will re-block");
    expect(content).not.toContain("no dedicated reset");
  });

  it("makes no PATCH call against /prs in the retry path", () => {
    expect(content).not.toMatch(/PATCH[^\n]*\/prs\//);
    expect(content).not.toMatch(/-X PATCH[\s\S]{0,200}\/prs\//);
  });

  it("has exactly one unblock call per item type in the default retry examples", () => {
    expect(content.match(/\/tasks\/\$TASK_ID\/unblock"/g)?.length).toBe(2); // default + `to` override
    expect(content.match(/\/prs\/\$PR_ID\/unblock"/g)?.length).toBe(1);
  });
});

describe("unblock.md — redirect (AC5 workflow)", () => {
  it("describes editing description/acceptanceCriteria before retrying", () => {
    expect(content).toContain("description");
    expect(content).toContain("acceptanceCriteria");
    const lower = content.toLowerCase();
    expect(lower).toContain("redirect");
    expect(lower).toContain("retry");
  });
});

describe("unblock.md — abandon (AC4)", () => {
  it("sets status:cancelled on abandon", () => {
    expect(content).toMatch(/status.{0,20}cancelled/s);
  });

  it("preserves blockedReason as a historical note rather than clearing it", () => {
    const lower = content.toLowerCase();
    const hasPreserveLanguage =
      lower.includes("preserve") ||
      lower.includes("do not clear") ||
      lower.includes("historical note") ||
      lower.includes("not cleared");
    expect(hasPreserveLanguage).toBe(true);
  });
});

describe("unblock.md — edge cases", () => {
  it("prints a clean message and stops when no blocked items are found", () => {
    const lower = content.toLowerCase();
    const hasNothingLanguage =
      lower.includes("nothing to triage") || lower.includes("no blocked items");
    expect(hasNothingLanguage).toBe(true);
  });

  it("human choice menu offers retry, redirect, and abandon", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("retry");
    expect(lower).toContain("redirect");
    expect(lower).toContain("abandon");
  });
});
