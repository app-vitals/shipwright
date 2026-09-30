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

  it("describes the ambiguous-Deploy-model fallback as detection poll first, not a direct staged poll", () => {
    expect(content).toContain("must never guess");
    // The fallback runs Step 5a's detection poll, and only escalates to the staged poll
    // if a Deploy workflow run is actually observed — otherwise it lands on Step 5c.
    expect(content).toContain("Deploy-workflow-detection poll");
    expect(content).toContain("only proceeds to the full staged");
    expect(content).toContain("post-merge CI watch (Step 5c)");
  });
});

describe("deploy.md — output", () => {
  it("documents a success/failure verdict", () => {
    expect(content.toLowerCase()).toContain("verdict");
    expect(content.toLowerCase()).toContain("success");
    expect(content.toLowerCase()).toContain("failure");
  });

  it("gives the SHA-only-fallback failure and pending-timeout outcomes their own verdict values", () => {
    expect(content).toContain("sha_only_fallback_failed");
    expect(content).toContain("sha_only_fallback_pending_timeout");
  });

  it("maps each SHA-only-fallback verdict to the right success value and task disposition", () => {
    const verdictBullet = content.slice(
      content.indexOf("- **`verdict`**"),
      content.indexOf("- **`pipeline_minutes`**"),
    );
    // Failure blocks the task; the pending timeout still marks it deployed.
    expect(verdictBullet).toMatch(/sha_only_fallback_failed`,\s*`success: false`/);
    expect(verdictBullet).toMatch(/sha_only_fallback_pending_timeout`,\s*`success: true`/);
    expect(verdictBullet).toContain("blocked");
    expect(verdictBullet).toContain("deployed");
    // The pending timeout matches the no-pipeline case, NOT the named-stage `pipeline_timeout`.
    expect(verdictBullet).toContain("post_merge_ci_pending_timeout");
    expect(verdictBullet).toMatch(/not\W{0,3}`pipeline_timeout`/);
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

  it("uses the real default workflow names, not the internal Promote stage label", () => {
    expect(content).toContain("Promote to Prod");
    // `"Promote"` alone is the internal stage label, never a GitHub Actions `.name` value.
    expect(content).not.toMatch(/"Promote"/);
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

  it("carves out the SHA-only-fallback success path, which never runs the health probe", () => {
    const healthCheckBullet = content.slice(
      content.indexOf("- **`health_check`**"),
      content.indexOf("## Scope"),
    );
    expect(healthCheckBullet).toContain("sha_only_fallback");
    expect(healthCheckBullet.toLowerCase()).toMatch(/exception|never/);
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
