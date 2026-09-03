import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  if (existsSync(SKILL_MD_PATH)) {
    content = readFileSync(SKILL_MD_PATH, "utf-8");
  } else {
    content = "";
  }
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
  it("has frontmatter with name: investigate-cron", () => {
    expect(content).toContain("name: investigate-cron");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — session matching pattern", () => {
  it("mentions the [Cron job: pattern for matching sessions", () => {
    expect(content).toContain("[Cron job:");
  });
});

describe("SKILL.md — workspace path encoding", () => {
  it("mentions replacing / and . with - for encoding the workspace path", () => {
    // Must mention that both / and . become -
    const hasSeparator =
      content.includes("replace") ||
      content.includes("Replace") ||
      content.includes("sed") ||
      content.includes("tr");
    const hasDotEncoding =
      content.includes(". with -") ||
      content.includes("`.` →") ||
      content.includes("`.`") ||
      content.includes("and `.`") ||
      content.includes("/ and .") ||
      content.includes('"." with') ||
      content.includes("'.' with") ||
      content.includes("tr '/.'") ||
      content.includes("s/[/.]");
    expect(hasSeparator && hasDotEncoding).toBe(true);
  });

  it("shows or describes the encoding transformation for workspace path", () => {
    // Should describe the encoding: /data/agent/home/workspace → -data-agent-home-workspace
    const hasExample =
      content.includes("-data-agent-home-workspace") ||
      content.includes("~/.claude/projects/") ||
      (content.includes("encoded") && content.includes("workspace"));
    expect(hasExample).toBe(true);
  });
});

describe("SKILL.md — Step 1: transcript directory", () => {
  it("has a Step 1 section about finding the transcript directory", () => {
    const hasStep1 =
      content.includes("Step 1") ||
      content.includes("## 1.") ||
      (content.includes("transcript") && content.includes("directory"));
    expect(hasStep1).toBe(true);
  });

  it("references ~/.claude/projects/ as the transcript root", () => {
    expect(content).toContain("~/.claude/projects/");
  });
});

describe("SKILL.md — Step 2: time conversion / Pacific timezone", () => {
  it("has a Step 2 section about time conversion", () => {
    const hasStep2 =
      content.includes("Step 2") ||
      content.includes("## 2.") ||
      (content.includes("time") && content.includes("convert"));
    expect(hasStep2).toBe(true);
  });

  it("mentions Pacific timezone as the default", () => {
    const hasPacific =
      content.includes("Pacific") ||
      content.includes("America/Los_Angeles") ||
      content.includes("US/Pacific");
    expect(hasPacific).toBe(true);
  });
});

describe("SKILL.md — Step 3: searching JSONL files", () => {
  it("has a Step 3 section about searching JSONL files", () => {
    const hasStep3 =
      content.includes("Step 3") ||
      content.includes("## 3.") ||
      content.includes("## 3:");
    expect(hasStep3).toBe(true);
  });

  it("mentions JSONL files", () => {
    expect(content.includes("jsonl") || content.includes("JSONL")).toBe(true);
  });

  it("describes a time window for searching (mtime or ±90 or similar)", () => {
    const hasWindow =
      content.includes("90") ||
      content.includes("mtime") ||
      content.includes("window") ||
      content.includes("±");
    expect(hasWindow).toBe(true);
  });
});

describe("SKILL.md — Step 4: extracting what happened", () => {
  it("has a Step 4 section about extracting session content", () => {
    const hasStep4 =
      content.includes("Step 4") ||
      content.includes("## 4.") ||
      content.includes("## 4:");
    expect(hasStep4).toBe(true);
  });

  it("mentions extracting assistant text outputs", () => {
    const hasAssistant =
      content.includes("assistant") || content.includes("text output");
    expect(hasAssistant).toBe(true);
  });

  it("mentions extracting bash commands", () => {
    const hasBash =
      content.includes("Bash") ||
      content.includes("bash") ||
      content.includes("command");
    expect(hasBash).toBe(true);
  });
});

describe("SKILL.md — Step 5: synthesis / explanation", () => {
  it("has a Step 5 section for synthesizing the explanation", () => {
    const hasStep5 =
      content.includes("Step 5") ||
      content.includes("## 5.") ||
      content.includes("## 5:");
    expect(hasStep5).toBe(true);
  });

  it("covers what the output explanation should include (cron name, time, session)", () => {
    const coversOutput =
      (content.includes("cron name") || content.includes("cron,")) &&
      (content.includes("session") || content.includes("Session")) &&
      (content.includes("time") || content.includes("Time"));
    expect(coversOutput).toBe(true);
  });
});

describe("SKILL.md — graceful no-match handling", () => {
  it("handles the case where no matching session is found", () => {
    const hasNoMatch =
      content.includes("no match") ||
      content.includes("No match") ||
      content.includes("not found") ||
      content.includes("no session") ||
      content.includes("no matching session");
    expect(hasNoMatch).toBe(true);
  });

  it("mentions preCheck or bodhi.log as a fallback when no session exists", () => {
    const hasFallback =
      content.includes("preCheck") ||
      content.includes("pre-check") ||
      content.includes("bodhi.log") ||
      content.includes("logs/");
    expect(hasFallback).toBe(true);
  });
});

describe("SKILL.md — --item mode", () => {
  it("Usage section documents --item mode", () => {
    expect(content).toContain("--item");
  });

  it("documents both accepted --item value forms (org/repo#N and bare taskId)", () => {
    expect(content).toContain("org/repo#");
  });

  it("has a Step 0 that routes on --item vs name+time", () => {
    const hasRouting =
      content.includes("ITEM_ARG") ||
      content.includes("item mode") ||
      content.includes("item-mode");
    expect(hasRouting).toBe(true);
  });
});

describe("SKILL.md — admin API run lookup", () => {
  it("references GET /agents/{id}/crons for resolving loopCronId/phaseId", () => {
    const hasCronsEndpoint =
      content.includes("/agents/$SHIPWRIGHT_AGENT_ID/crons") ||
      content.includes("/agents/{id}/crons");
    expect(hasCronsEndpoint).toBe(true);
  });

  it("references GET /agents/{id}/crons/{loopCronId}/runs", () => {
    const hasRunsEndpoint =
      content.includes("/crons/$LOOP_CRON_ID/runs") ||
      content.includes("/crons/{loopCronId}/runs") ||
      content.includes("/crons/${LOOP_CRON_ID}/runs");
    expect(hasRunsEndpoint).toBe(true);
  });

  it("mentions loopCronId and phaseId concepts", () => {
    expect(content).toContain("loopCronId");
    expect(content).toContain("phaseId");
  });

  it("mentions itemId filtering for item mode", () => {
    expect(content).toContain("itemId");
  });

  it("documents that runs endpoint filtering is done server-side via itemId/phaseId query params", () => {
    const hasServerSideNote =
      content.includes("server-side `itemId`/`phaseId`") ||
      (content.includes("server-side") && content.includes("query filters"));
    expect(hasServerSideNote).toBe(true);
  });

  it("uses SHIPWRIGHT_AGENT_API_KEY bearer auth for admin API calls", () => {
    expect(content).toContain(
      "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY",
    );
  });
});

describe("SKILL.md — fallback: pre-admin-API history retained", () => {
  it("labels the old ±90min/mtime approach as a documented fallback", () => {
    const hasFallbackLabel =
      content.includes("Fallback") || content.includes("fallback");
    // Must still retain the old mtime window content alongside the fallback label
    const hasOldWindowContent =
      content.includes("90") && content.includes("mtime");
    expect(hasFallbackLabel && hasOldWindowContent).toBe(true);
  });

  it("still mentions the [Cron job: string-matching approach as part of the fallback", () => {
    expect(content).toContain("[Cron job:");
  });
});

describe("SKILL.md — Step 2: ground-truth snapshot (IC-1.2)", () => {
  it("has a Step 2 section about a ground-truth snapshot, run before transcript extraction", () => {
    const hasGroundTruthStep =
      content.includes("ground-truth") || content.includes("ground truth");
    expect(hasGroundTruthStep).toBe(true);
  });

  it("queries GET /agents/{id}/work-queue", () => {
    expect(content).toContain("/work-queue");
  });

  it("notes the work-queue endpoint is a push/pull snapshot, not live-computed, and 404s if never pushed", () => {
    const hasSnapshotCaveat =
      content.includes("snapshot") &&
      (content.includes("404") || content.includes("never pushed"));
    expect(hasSnapshotCaveat).toBe(true);
  });

  it("queries the task-store /prs?repo=&prNumber= endpoint", () => {
    expect(content).toContain("/prs?repo=");
  });

  it("queries the task-store /tasks/{id} endpoint", () => {
    expect(content).toContain("/tasks/");
  });

  it("surfaces claimedBy, hitl, reviewState, patchCycles from the task-store PR record (not taskId)", () => {
    expect(content).toContain("claimedBy");
    expect(content).toContain("hitl");
    expect(content).toContain("reviewState");
    expect(content).toContain("patchCycles");
    // taskId should NOT be in the diagnostic print — it's being removed from the schema
    expect(content.match(/jq '.*taskId.*'/)).toBeNull();
  });

  it("queries task-store GET /tasks?repo=&pr= to resolve task ids for a PR (live lookup, not stored .taskId fallback)", () => {
    const hasLiveTaskLookup =
      content.includes("/tasks?repo=") &&
      content.includes("&pr=") &&
      !content.match(/\.taskId\s*\/\/\s*empty/); // Should NOT fall back to stored .taskId
    expect(hasLiveTaskLookup).toBe(true);
  });

  it("does not gate the PR-reference task lookup on PR_RECORD_JSON being non-empty", () => {
    // PR_RECORD_JSON only reflects whether the task-store's PullRequest record
    // exists (created on first review/patch/deploy claim), not whether ITEM_ARG
    // is a PR reference. A freshly-opened, not-yet-claimed PR has no
    // PullRequest record yet but real Task records already exist — gating on
    // PR_RECORD_JSON would silently skip the live lookup for that case.
    expect(content).not.toContain('elif [ -n "$PR_RECORD_JSON" ]');
  });

  it("queries live GitHub state via gh pr view with mergeStateStatus/headRefOid", () => {
    expect(content).toContain("gh pr view");
    expect(content).toContain("mergeStateStatus");
    expect(content).toContain("headRefOid");
  });

  it("explicitly diffs live GitHub state against the task-store's cached view, calling out drift", () => {
    const hasDriftCheck =
      (content.includes("drift") || content.includes("discrepancy")) &&
      content.includes("cached");
    expect(hasDriftCheck).toBe(true);
  });

  it("states the ground-truth step applies to both name+time and --item modes", () => {
    const hasBothModes =
      content.includes("both name") ||
      (content.includes("name+time") && content.includes("--item"));
    expect(hasBothModes).toBe(true);
  });

  it("states the skill may conclude without transcript extraction when ground-truth signals are decisive", () => {
    const hasShortCircuit =
      content.includes("without") &&
      (content.includes("transcript extraction") || content.includes("extracting a transcript"));
    expect(hasShortCircuit).toBe(true);
  });
});

describe("SKILL.md — renumbered steps after Step 4 insertion (IC-1.3)", () => {
  it("has a consolidated Step 3 section covering transcript location and extraction", () => {
    expect(content).toContain("Step 3: Locate and extract the transcript");
  });

  it("has a 3a subheading about converting the time argument (merged from old Step 3)", () => {
    expect(content).toContain("3a. Convert the time argument");
  });

  it("has a 3b subheading about finding matching sessions (merged from old Step 4)", () => {
    expect(content).toContain("3b. Find matching sessions");
  });

  it("has a 3c subheading about extracting what happened (merged from old Step 5)", () => {
    expect(content).toContain("3c. Extract what happened");
  });

  it("has a Step 4 section about the Sentry cross-check (new, IC-1.3)", () => {
    expect(content).toContain("Step 4: Sentry cross-check");
  });

  it("has a Step 5 section about synthesizing the explanation (renumbered from old Step 6)", () => {
    expect(content).toContain("Step 5: Synthesize the explanation");
  });
});

describe("SKILL.md — Step 4: Sentry cross-check (IC-1.3)", () => {
  it("gates on SENTRY_ORG and SENTRY_AUTH_TOKEN being set", () => {
    expect(content).toContain("SENTRY_ORG");
    expect(content).toContain("SENTRY_AUTH_TOKEN");
  });

  it("skips cleanly with a printed notice when either credential is unset", () => {
    expect(content).toContain("Skipping");
  });

  it("queries the Sentry Issues API scoped to is:unresolved", () => {
    expect(content).toContain("is:unresolved");
  });

  it("queries the ourlogs structured-logs dataset via the Events API", () => {
    expect(content).toContain("dataset=ourlogs");
  });
});

describe("SKILL.md — Step 1b populates ITEM_ARG in name+time mode (review fix)", () => {
  it("assigns ITEM_ARG from BEST_RUN's itemId so Step 2's item-scoped signals resolve in name+time mode", () => {
    expect(content).toContain(
      'ITEM_ARG=$(echo "$BEST_RUN" | jq -r \'.itemId // empty\')',
    );
  });

  it("documents that ITEM_ARG degrades gracefully to empty when the resolved run has no itemId", () => {
    expect(content).toContain("If `BEST_RUN` has no `itemId`");
  });
});
