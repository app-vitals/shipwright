import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH)
    ? readFileSync(SKILL_MD_PATH, "utf-8")
    : "";
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — frontmatter", () => {
  it("has frontmatter with name: investigate-stuck", () => {
    expect(content).toContain("name: investigate-stuck");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — usage (item only)", () => {
  it("documents the <org/repo#N|taskId> argument", () => {
    expect(content).toContain("<org/repo#N|taskId>");
    expect(content).toContain("org/repo#");
  });

  it("binds ITEM_ARG from the invocation", () => {
    expect(content).toContain("ITEM_ARG");
  });

  it("no longer exposes the name+time mode or --item flag", () => {
    expect(content).not.toContain("--item");
    expect(content).not.toContain("TARGET_EPOCH");
    expect(content).not.toContain("3a. Convert the time argument");
  });
});

describe("SKILL.md — delegation to agent-platform:investigate-cron", () => {
  it("delegates transcript extraction, Sentry and synthesis structure", () => {
    expect(content).toContain("agent-platform:investigate-cron");
  });

  it("does not re-implement transcript extraction or the Sentry cross-check", () => {
    expect(content).not.toContain("dataset=ourlogs");
    expect(content).not.toContain("is:unresolved");
    expect(content).not.toContain("[Cron job:");
    expect(content).not.toContain("glob.glob");
  });

  it("does not reference the retired shipwright-namespaced investigate-cron skill", () => {
    // Built from parts so the repo-wide grep for the old name stays clean.
    expect(content).not.toContain(`${"shipwright"}:${"investigate"}-cron`);
  });
});

describe("SKILL.md — admin API run lookup", () => {
  it("references GET /agents/{id}/crons for resolving loopCronId", () => {
    expect(content).toContain("/agents/$SHIPWRIGHT_AGENT_ID/crons");
    expect(content).toContain("loopCronId");
  });

  it("references the loop cron runs endpoint filtered server-side by itemId", () => {
    expect(content).toContain("/crons/$LOOP_CRON_ID/runs");
    expect(content).toContain("itemId");
    expect(content).toContain("server-side");
  });

  it("maps phaseId to phase cron names (shipwright-loop and phase cron resolution)", () => {
    expect(content).toContain("phaseId");
    expect(content).toContain("shipwright-loop");
  });

  it("uses SHIPWRIGHT_AGENT_API_KEY bearer auth for admin API calls", () => {
    expect(content).toContain(
      "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY",
    );
  });
});

describe("SKILL.md — ground-truth snapshot", () => {
  it("has a ground-truth step run before transcript extraction", () => {
    expect(content.includes("ground-truth") || content.includes("ground truth")).toBe(true);
  });

  it("queries GET /agents/{id}/work-queue and notes the snapshot caveat", () => {
    expect(content).toContain("/work-queue");
    expect(content).toContain("snapshot");
    expect(content.includes("404") || content.includes("never pushed")).toBe(true);
  });

  it("queries the task-store /prs?repo= and /tasks/{id} endpoints", () => {
    expect(content).toContain("/prs?repo=");
    expect(content).toContain("/tasks/");
  });

  it("surfaces claimedBy, hitl, reviewState, patchCycles (not taskId) from the PR record", () => {
    expect(content).toContain("claimedBy");
    expect(content).toContain("hitl");
    expect(content).toContain("reviewState");
    expect(content).toContain("patchCycles");
    expect(content.match(/jq '.*taskId.*'/)).toBeNull();
  });

  it("resolves tasks for a PR via live GET /tasks?repo=&pr= (no stored .taskId fallback)", () => {
    expect(content).toContain("/tasks?repo=");
    expect(content).toContain("&pr=");
    expect(content).not.toMatch(/\.taskId\s*\/\/\s*empty/);
  });

  it("does not gate the PR-reference task lookup on PR_RECORD_JSON being non-empty", () => {
    expect(content).not.toContain('elif [ -n "$PR_RECORD_JSON" ]');
  });

  it("queries live GitHub state via gh pr view with mergeStateStatus/headRefOid", () => {
    expect(content).toContain("gh pr view");
    expect(content).toContain("mergeStateStatus");
    expect(content).toContain("headRefOid");
  });

  it("diffs live GitHub state against the task-store's cached view", () => {
    expect(content.includes("DISCREPANCY") || content.includes("drift")).toBe(true);
    expect(content).toContain("cached");
  });

  it("may conclude without transcript extraction when ground-truth signals are decisive", () => {
    expect(content).toContain("without");
    expect(content).toContain("transcript extraction");
  });
});
