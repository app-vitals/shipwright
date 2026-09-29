import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "deploy.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("deploy.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("deploy.md — framed as an implementation-agnostic interface contract", () => {
  it("frames the contract as applying to any deploy-phase subagent, not just the built-in implementation", () => {
    expect(content.toLowerCase()).toMatch(/any (?:deploy-phase )?subagent|custom subagent/);
  });

  it("references commands/deploy.md as the reference implementation", () => {
    expect(content).toContain("commands/deploy.md");
  });

  it("names the deploy AgentPhaseMethodology phase value", () => {
    expect(content).toContain('"deploy"');
  });
});

describe("deploy.md — inputs", () => {
  it("documents the merged commit SHA input", () => {
    expect(content).toContain("SQUASH_SHA");
  });

  it("documents org/repo and PR metadata inputs", () => {
    expect(content.toLowerCase()).toContain("org");
    expect(content.toLowerCase()).toContain("repo");
    expect(content).toContain("PR_TITLE");
  });

  it("documents the bundle-aware task id inputs", () => {
    expect(content).toContain("TASK_ID");
    expect(content).toContain("TASK_IDS");
    expect(content.toLowerCase()).toContain("bundle");
  });

  it("documents the claimed PullRequest record id used for heartbeat renewal", () => {
    expect(content).toContain("PR_RECORD_ID");
    expect(content.toLowerCase()).toContain("heartbeat");
  });

  it("documents deploy_started_at and its use for pipeline timing", () => {
    expect(content).toContain("deploy_started_at");
    expect(content.toLowerCase()).toContain("timing");
  });

  it("documents the resolved target-repo Deploy model input", () => {
    expect(content).toContain("Deploy model");
    expect(content).toContain("direct");
    expect(content).toContain("staged");
    expect(content).toContain("CLAUDE.md");
  });
});

describe("deploy.md — output", () => {
  it("documents a success/failure verdict", () => {
    expect(content.toLowerCase()).toContain("verdict");
    expect(content.toLowerCase()).toContain("success");
    expect(content.toLowerCase()).toContain("failure");
  });

  it("documents pipeline_minutes", () => {
    expect(content).toContain("pipeline_minutes");
  });

  it("documents which stage(s) ran, including the SHA-only fallback set", () => {
    expect(content).toContain("stages");
    expect(content).toContain("run_id");
    expect(content).toContain("conclusion");
    expect(content.toLowerCase()).toContain("sha-only fallback");
  });

  it("documents a failure-reason string mirroring the task-store PATCH note/blockedReason", () => {
    expect(content).toContain("failure_reason");
    expect(content).toContain("Deploy stage failed");
    expect(content).toContain("canary_blocked");
    expect(content).toContain("Pipeline timeout after 30 minutes");
  });

  it("documents the revert PR URL, present only on canary failure", () => {
    expect(content).toContain("revert_pr_url");
    expect(content.toLowerCase()).toContain("canary");
  });

  it("documents the health-check status/URL as informational, never gating", () => {
    expect(content).toContain("health_check");
    expect(content.toLowerCase()).toContain("informational");
  });
});

describe("deploy.md — scope", () => {
  it("clarifies the subagent does not merge, claim/release, or write task-store status", () => {
    expect(content.toLowerCase()).toMatch(/task[ -]store/);
    expect(content.toLowerCase()).toMatch(
      /does not merge the pr|does not claim or release|does not write any task-store status/,
    );
  });

  it("carves out the heartbeat renewal and revert PR as the execution step's own writes", () => {
    expect(content.toLowerCase()).toContain("heartbeat");
    expect(content).toContain("revert_pr_url");
    // The caller surfaces the URL; it does not open the PR itself (the execution step does).
    expect(content).not.toContain("opening the revert PR itself");
  });

  it("draws the caller/subagent boundary explicitly", () => {
    expect(content.toLowerCase()).toContain("caller");
  });
});
