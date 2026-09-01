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
    "review-finding fix blocked",
    "CI-fix blocked",
  ];
  const deployReasons = [
    "Post-merge CI failed",
    "Deploy stage failed",
    "canary_blocked",
    "Pipeline timeout",
    "Canary failed after deploy",
    "Post-merge CI still pending after 10 minutes",
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

  it("mentions every deploy.md blockedReason pattern", () => {
    for (const reason of deployReasons) {
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

  it("notes there is no dedicated reset endpoint for the PR-side consecutiveCiFailureCount streak", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("no dedicated reset");
  });

  it("attributes dev-task reasons to the dev-task phase, patch reasons to patch, deploy reasons to deploy", () => {
    expect(content).toMatch(/dev-task/);
    expect(content).toMatch(/patch/);
    expect(content).toMatch(/deploy/);
  });

  it("handles an unrecognized blockedReason as unknown origin phase rather than guessing", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("unknown");
  });
});

describe("unblock.md — retry logic (AC3)", () => {
  it("distinguishes task.pr-having tasks (status:pr_open) from no-PR tasks (status:pending via release)", () => {
    expect(content).toContain("pr_open");
    expect(content).toContain("/release");
  });

  it("uses POST /tasks/:id/release for the no-PR retry case, not a raw PATCH status:pending", () => {
    expect(content).toContain("/release");
    // The raw-PATCH-to-pending path must be called out as disallowed for agent tokens.
    const lower = content.toLowerCase();
    expect(lower).toContain("agent token");
    expect(lower).toContain("cannot");
  });

  it("PATCHes status:pr_open directly (not release) when task.pr is set", () => {
    expect(content).toMatch(/status.{0,20}pr_open/s);
  });

  it("clears blockedReason and blockedAt on retry", () => {
    expect(content).toContain("blockedReason");
    expect(content).toContain("blockedAt");
    const lower = content.toLowerCase();
    expect(lower).toContain("clear");
  });

  it("resets skipCount to 0 via POST /tasks/:id/skip/reset when blockedReason indicates spin-detection", () => {
    expect(content).toContain("/skip/reset");
    expect(content).toContain("Auto-blocked after");
  });

  it("also resets skipCount via POST /prs/:id/skip/reset for a PR-only record hit by the skip-count spin-detection variant", () => {
    expect(content).toMatch(/\/prs\/(\{|\$)[A-Za-z0-9_]*\}?\/skip\/reset/);
    const lower = content.toLowerCase();
    // The skip-count row/step must not be described as task-only, since PullRequest
    // carries its own skipCount/lastSkippedAt and recordSkip() produces the identical
    // blockedReason string on a PR-only record.
    expect(lower).not.toContain("task-only, tracked via `skipcount`");
  });

  it("retries PR-only records (no linked task) via PATCH /prs/:id with blocked:false", () => {
    expect(content).toMatch(/PATCH.{0,200}\/prs\/(\{|\$)/s);
    expect(content).toContain("blocked");
    expect(content).toMatch(/blocked.{0,20}false/s);
  });

  it("distinguishes the three retry destinations explicitly: pr_open, pending via release, and PR blocked:false", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("pr_open");
    expect(lower).toContain("no pr");
    expect(lower).toContain("pr-only");
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
