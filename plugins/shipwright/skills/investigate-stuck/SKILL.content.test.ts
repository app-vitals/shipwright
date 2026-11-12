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

describe("SKILL.md — item-mode output sections", () => {
  it("documents the item-mode output format headers", () => {
    expect(content).toContain("Item: <org/repo#N|taskId>");
    expect(content).toContain("Dispatch history (<N> run(s) across <phases>):");
    expect(content).toContain("Phase:");
    expect(content).toContain("What happened:");
    expect(content).toContain("Conclusion:");
    expect(content).toContain("(session: <session-id>)");
  });

  it("is chronological, one entry per dispatch", () => {
    expect(content).toContain("chronological");
  });

  it("has a no-dispatch-history handler mentioning preCheck", () => {
    expect(content).toContain('No dispatch history found for item "<item>"');
    expect(content).toContain("preCheck");
  });
});

describe("SKILL.md — work-queue snapshot detail", () => {
  it("surfaces the item's rank/age from the array-index ranking", () => {
    expect(content).toContain("rank");
    expect(content).toContain("age");
    expect(content).toContain("work-queue");
  });

  it("surfaces the readyFor*At fields from the task-store record", () => {
    expect(content).toContain("readyForReviewAt");
    expect(content).toContain("readyForPatchAt");
    expect(content).toContain("readyForMergeAt");
  });

  it("loops over the multi-task bundle case", () => {
    expect(content).toContain("bundle");
    expect(content).toContain("Loop over zero, one, or many tasks");
  });

  it("notes gh pr checks may not work with agent PATs", () => {
    expect(content).toContain("gh pr checks");
    expect(content).toContain("PAT");
  });

  it("degrades gracefully when snapshot or task-store record is unavailable", () => {
    expect(content).toContain("not yet tracked");
    expect(content).toContain("never pushed");
  });
});

describe("SKILL.md — step structure and delegation", () => {
  it("has Step 1 run lookup, Step 2 ground-truth, Step 3 delegation, Step 4 synthesis", () => {
    expect(content).toContain("## Step 1: Resolve the item's runs");
    expect(content).toContain("## Step 2: Ground-truth snapshot");
    expect(content).toContain("## Step 3: Delegate transcript extraction");
    expect(content).toContain("## Step 4: Synthesize");
  });

  it("Step 3 hands each run's sessionId and startedAt to agent-platform:investigate-cron", () => {
    const step3 = content.slice(
      content.indexOf("## Step 3: Delegate transcript extraction"),
      content.indexOf("## Step 4: Synthesize"),
    );
    expect(step3).toContain("agent-platform:investigate-cron");
    expect(step3).toContain("sessionId");
    expect(step3).toContain("startedAt");
    expect(step3).toContain("Sentry");
  });

  it("scopes out broader why-is-it-stuck features", () => {
    expect(content).toContain("Out of scope");
  });
});
