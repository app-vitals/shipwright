import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_MD_PATH = join(import.meta.dir, "deploy.md");

let content: string;

beforeAll(() => {
  content = readFileSync(DEPLOY_MD_PATH, "utf-8");
});

function extractStep2aSection(md: string): string {
  const match = md.match(/### 2a\. Own-PRs-Only Check[\s\S]*?(?=\n### 2b)/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractStep5aSection(md: string): string {
  const match = md.match(
    /### 5a\. No-Pipeline Detection[\s\S]*?(?=\n#{2,3} |\n---)/,
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractStep5bSection(md: string): string {
  const match = md.match(
    /### 5b\. Monitor Pipeline[\s\S]*?(?=\n#{2,3} |\n---)/,
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractStep3aSection(md: string): string {
  const match = md.match(
    /### 3a\. Verify PR Approval[\s\S]*?(?=\n#{2,3} |\n---)/,
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractStep3bSection(md: string): string {
  const match = md.match(/### 3b\. Verify[\s\S]*?(?=\n#{2,3} |\n---)/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("deploy.md — own-PRs-only check (AC1 & AC2)", () => {
  it("contains own GH login check (AGENT_LOGIN or 'own GH login')", () => {
    const hasAgentLogin = content.includes("AGENT_LOGIN");
    const hasOwnGhLogin = content.includes("own GH login");
    expect(hasAgentLogin || hasOwnGhLogin).toBe(true);
  });

  it("contains PR_AUTHOR check to identify who authored the PR", () => {
    expect(content).toContain("PR_AUTHOR");
  });

  it("states that PRs authored by others are skipped silently", () => {
    const hasSkipSilently =
      content.includes("skip it silently") || content.includes("skip silently");
    expect(hasSkipSilently).toBe(true);
  });

  it("Step 2a emits the explicit [silent] marker for the own-PRs-only check, matching the file's convention", () => {
    const step2aSection = extractStep2aSection(content);
    expect(step2aSection).toContain("[silent]");
  });

  it("Step 2a's own-PRs-only check does not add a [skip-reason:...] tag — a genuine not-applicable case, not a defer", () => {
    const step2aSection = extractStep2aSection(content);
    expect(step2aSection).not.toContain("[skip-reason:");
  });
});

describe("deploy.md — no-pipeline detection (AC3 & AC4)", () => {
  it("polls for Deploy workflow for up to 5 minutes after merge", () => {
    // Must mention 5 minutes in the context of no-pipeline detection
    const has5MinPoll =
      content.includes("5 minutes") || content.includes("5-minute");
    expect(has5MinPoll).toBe(true);
  });

  it("prints 'No Deploy workflow' message when no pipeline fires", () => {
    expect(content).toContain("No Deploy workflow");
  });

  it("marks task deployed and exits cleanly when no pipeline fires", () => {
    const hasNoPipelineExit =
      content.includes("no_pipeline") ||
      content.includes("no pipeline") ||
      content.includes("no deploy pipeline");
    expect(hasNoPipelineExit).toBe(true);
  });
});

describe("deploy.md — full 30-minute watch (AC5)", () => {
  it("still runs the full 30-minute pipeline watch when Deploy workflow IS detected", () => {
    const has30Min =
      content.includes("30-minute") ||
      content.includes("30 minutes") ||
      content.includes("Budget: 30 minutes");
    expect(has30Min).toBe(true);
  });
});

describe("deploy.md — PR upsert on merge (PRI-2.4)", () => {
  it("contains POST /prs/claim to create or claim PR record", () => {
    const hasClaimCall =
      content.includes("/prs/claim") || content.includes("prs/claim");
    expect(hasClaimCall).toBe(true);
  });

  it("passes repo, prNumber, and commitSha (SQUASH_SHA) to POST /prs/claim", () => {
    const hasRepo =
      (content.includes('"repo"') || content.includes("repo")) &&
      content.includes("{org}/{repo}");
    const hasPrNumber =
      (content.includes('"prNumber"') || content.includes("prNumber")) &&
      (content.includes("{pr}") || content.includes("prNumber"));
    const hasCommitSha =
      (content.includes('"commitSha"') || content.includes("commitSha")) &&
      content.includes("SQUASH_SHA");
    expect(hasRepo && hasPrNumber && hasCommitSha).toBe(true);
  });

  it("contains PATCH /prs/:id with state=merged to mark PR as merged", () => {
    const hasPatchCall = content.includes("/prs/");
    const hasStateMerged =
      content.includes("state") &&
      (content.includes("merged") || content.includes('merged"'));
    expect(hasPatchCall && hasStateMerged).toBe(true);
  });

  it("includes mergedAt timestamp in PATCH request", () => {
    const hasMergedAt =
      content.includes('"mergedAt"') ||
      content.includes("mergedAt") ||
      content.includes("mergedAt:");
    expect(hasMergedAt).toBe(true);
  });

  it("includes reviewState=approved in PATCH request", () => {
    const hasReviewState =
      content.includes("reviewState") && content.includes("approved");
    expect(hasReviewState).toBe(true);
  });

  it("warns and continues if PR upsert fails", () => {
    const hasWarning =
      content.includes("⚠") ||
      content.includes("warn") ||
      content.includes("Failed to upsert");
    expect(hasWarning).toBe(true);
  });

  it("extracts PR_RECORD_ID from POST /prs/claim response", () => {
    const hasPrRecordId =
      content.includes("PR_RECORD_ID") || content.includes("pr_record_id");
    expect(hasPrRecordId).toBe(true);
  });
});

describe("deploy.md — self-approve bold-markdown strip (PCK-1.4)", () => {
  it("Step 3a's AGENT_LOGIN self-approval check strips leading ** before the comparison", () => {
    const step3aMatch = content.match(
      /### 3a\. Verify PR Approval[\s\S]*?(?=### 3b)/,
    );
    expect(step3aMatch).not.toBeNull();
    const step3aSection = step3aMatch?.[0] ?? "";
    expect(step3aSection).toContain('sub("^\\\\*+";"")');
    expect(step3aSection.toLowerCase()).toContain("strip");
  });

  it('Step 3a\'s prose describes stripping leading bold markers before startsWith("APPROVE")', () => {
    const step3aMatch = content.match(
      /### 3a\. Verify PR Approval[\s\S]*?(?=### 3b)/,
    );
    const step3aSection = step3aMatch?.[0] ?? "";
    expect(step3aSection).toContain('startsWith("APPROVE")');
  });
});

describe("deploy.md — scan mode removed (WLS-3.4)", () => {
  it("does not contain a Step 1 Scan Mode section", () => {
    expect(content).not.toContain("Scan Mode");
    expect(content).not.toContain("## Step 1");
  });

  it("does not reference CANDIDATE_LIST or scan-mode candidate fallback", () => {
    expect(content).not.toContain("CANDIDATE_LIST");
    expect(content.toLowerCase()).not.toContain("scan mode");
  });

  it("states $ARGUMENTS is required and no-argument invocation responds [silent]", () => {
    const argsMatch = content.match(/## Arguments[\s\S]*?(?=---)/);
    expect(argsMatch).not.toBeNull();
    const argsSection = argsMatch?.[0] ?? "";
    expect(argsSection).toContain("required");
    expect(argsSection).toContain("[silent]");
  });
});

describe("deploy.md — pre-merge PR claim lock (CLM-2.2)", () => {
  it("claims the PR record (phase: deploy) before the gh pr merge call", () => {
    // The pre-merge claim must appear BEFORE the merge command in Step 4.
    // Format-independent: matches the claim call site and the merge command
    // literally, rather than a bash-escaped JSON body fragment that would
    // break silently if the claim body's quoting style changed.
    const claimIdx = content.indexOf("/prs/claim");
    const mergeIdx = content.indexOf("gh pr merge {pr}");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(mergeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeLessThan(mergeIdx);
  });

  it("skips the merge and does not call gh pr merge when the claim returns 409", () => {
    const hasConflictHandling =
      content.includes("PR_CLAIM") &&
      (content.includes('"409"') || content.includes("409"));
    const hasSkipLanguage =
      content.includes("do NOT merge") || content.includes("skipping");
    expect(hasConflictHandling).toBe(true);
    expect(hasSkipLanguage).toBe(true);
  });

  it("post-merge upsert reuses PR_RECORD_ID from the pre-merge claim (plain PATCH, no redundant claim)", () => {
    // The post-merge section should PATCH the already-claimed record rather than
    // issuing a second POST /prs/claim call.
    const postMergeSectionIdx = content.indexOf(
      "Update PullRequest Record (post-merge)",
    );
    expect(postMergeSectionIdx).toBeGreaterThan(-1);
    const postMergeSection = content.slice(
      postMergeSectionIdx,
      postMergeSectionIdx + 1500,
    );
    expect(postMergeSection.includes("/prs/claim")).toBe(false);
    expect(postMergeSection.includes("/prs/$PR_RECORD_ID")).toBe(true);
  });

  it("releases the pre-merge claim if the merge does not complete within 60 seconds", () => {
    // A stuck/timed-out merge must not leave the phase: "deploy" claim dangling —
    // otherwise a retry within the claim TTL hits a spurious 409.
    const timeoutIdx = content.indexOf("did not complete within 60 seconds");
    expect(timeoutIdx).toBeGreaterThan(-1);
    const beforeTimeout = content.slice(0, timeoutIdx);
    const releaseIdx = beforeTimeout.lastIndexOf("/prs/$PR_RECORD_ID/release");
    expect(releaseIdx).toBeGreaterThan(-1);
    // The release call must come after the pre-merge claim and before the timeout message
    const claimIdx = content.indexOf("/prs/claim");
    expect(releaseIdx).toBeGreaterThan(claimIdx);
  });

  it("does not PATCH task status to blocked on a merge-timeout/conflict failure", () => {
    // Merge conflicts are routine and self-recoverable (check-patch.ts fixes any DIRTY
    // PR regardless of task status) — writing status:"blocked" here would hide the PR
    // from check-deploy.ts's candidate list even after patch resolves it, stranding the
    // task until a human notices. This section must leave task status untouched.
    const timeoutIdx = content.indexOf("did not complete within 60 seconds");
    expect(timeoutIdx).toBeGreaterThan(-1);
    const nextSectionIdx = content.indexOf("### 4c.", timeoutIdx);
    expect(nextSectionIdx).toBeGreaterThan(timeoutIdx);
    const failureSection = content.slice(timeoutIdx, nextSectionIdx);
    expect(failureSection).not.toContain('"status": "blocked"');
    expect(failureSection.toLowerCase()).toContain("do not patch the task");
  });
});

describe("deploy.md — pre-claim fast path (CBD-1.6)", () => {
  it("Arguments section documents the [preclaim:{recordId}:{commitSha}] marker format", () => {
    const argsMatch = content.match(/## Arguments[\s\S]*?(?=---)/);
    expect(argsMatch).not.toBeNull();
    const argsSection = argsMatch?.[0] ?? "";
    expect(argsSection).toContain("[preclaim:{recordId}:{commitSha}]");
    expect(argsSection).toContain("loop-orchestrator.ts");
    expect(argsSection).toContain("formatPreClaimMarker");
  });

  it("Step 2 parses and strips the marker, extracting PRECLAIM_RECORD_ID/PRECLAIM_COMMIT_SHA", () => {
    const step2Match = content.match(
      /## Step 2: Resolve Target PR[\s\S]*?(?=\n---|\n## Step 3)/,
    );
    expect(step2Match).not.toBeNull();
    const step2Section = step2Match?.[0] ?? "";
    expect(step2Section).toContain("PRECLAIM_RECORD_ID");
    expect(step2Section).toContain("PRECLAIM_COMMIT_SHA");
    expect(step2Section).toContain("strip");
  });

  it("Step 4a has a Pre-Claim Fast Path section", () => {
    const sectionIdx = content.indexOf("Pre-Claim Fast Path (CBD-1.6)");
    expect(sectionIdx).toBeGreaterThan(-1);
  });

  it("Pre-Claim Fast Path validates the marker's commitSha against a freshly-fetched live head", () => {
    const sectionIdx = content.indexOf("Pre-Claim Fast Path (CBD-1.6)");
    const section = content.slice(sectionIdx, sectionIdx + 1200);
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
    expect(section).toContain("HEAD_SHA_PRE_MERGE");
  });

  it("Pre-Claim Fast Path trusts a matching marker: sets PR_RECORD_ID = PRECLAIM_RECORD_ID and skips the claim call", () => {
    const sectionIdx = content.indexOf("Pre-Claim Fast Path (CBD-1.6)");
    const section = content.slice(sectionIdx, sectionIdx + 1200);
    expect(section).toContain("PR_RECORD_ID = PRECLAIM_RECORD_ID");
    expect(section.toLowerCase()).toContain("skip");
  });

  it("Pre-Claim Fast Path falls back to self-claiming on a stale or absent marker", () => {
    const sectionIdx = content.indexOf("Pre-Claim Fast Path (CBD-1.6)");
    const section = content.slice(sectionIdx, sectionIdx + 1200);
    expect(section).toContain("HEAD_SHA_PRE_MERGE != PRECLAIM_COMMIT_SHA");
    expect(section.toLowerCase()).toContain("no marker present");
  });

  it("Pre-Claim Fast Path appears before the self-claim POST /prs/claim call in Step 4a", () => {
    const fastPathIdx = content.indexOf("Pre-Claim Fast Path (CBD-1.6)");
    const claimCallIdx = content.indexOf(
      "$SHIPWRIGHT_TASK_STORE_URL/prs/claim",
    );
    expect(fastPathIdx).toBeGreaterThan(-1);
    expect(claimCallIdx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeLessThan(claimCallIdx);
  });
});

describe("deploy.md — chained in-Bash polling for Step 5b (AEW-1.1)", () => {
  it("Step 5b's polling implementation uses a chained in-Bash sleep loop (shell for-loop + sleep 60)", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain("sleep 60");
    const hasForLoop =
      /for\s+\w+\s+in\s+\$\(seq/.test(step5bSection) ||
      step5bSection.includes("for i in");
    expect(hasForLoop).toBe(true);
  });

  it("Step 5b instructs chaining multiple Bash tool calls back-to-back to cover the 30-minute budget", () => {
    const step5bSection = extractStep5bSection(content);
    const mentionsChaining =
      step5bSection.toLowerCase().includes("chain") &&
      step5bSection.toLowerCase().includes("bash");
    expect(mentionsChaining).toBe(true);
  });

  it("Step 5b's polling section does NOT instruct a per-60s ScheduleWakeup call", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).not.toContain("ScheduleWakeup");
  });

  it("preserves the midpoint claim-heartbeat renewal (elapsed ~15 minutes) inside Step 5b", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain("/prs/$PR_RECORD_ID/heartbeat");
    expect(step5bSection.toLowerCase()).toContain("midpoint");
  });

  it("preserves the 60-second poll interval and 30-minute budget wording in Step 5b", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain("60 seconds");
    expect(step5bSection).toContain("30 minutes");
  });

  it("preserves the progress print format for Deploy/Canary/Promote stages", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain(
      "[{elapsed}m] Deploy: {status}/{conclusion} | Canary: {status}/{conclusion} | Promote: {status}/{conclusion}",
    );
  });

  it("does not affect the ARC desync section, which still re-surfaces every 5 minutes", () => {
    // ARC desync detection lives just after Step 5b in the same file; it must be
    // untouched by the polling-mechanism rewrite.
    expect(content).toContain("ARC desync suspected");
    expect(content).toContain("Re-surface this message every 5 minutes");
  });
});

describe("deploy.md — validate workflow names before Step 5b watch (DWV-1.1)", () => {
  it("Step 5b performs a one-time validation of resolved stage names against live repo workflows via gh api actions/workflows", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain("actions/workflows");
    expect(step5bSection).toContain("gh api repos/{org}/{repo}/actions/workflows");
  });

  it("positions the workflow-name validation after the Stage-names resolution/table and before the progress-print line", () => {
    const step5bSection = extractStep5bSection(content);
    const stageNamesIdx = step5bSection.indexOf(
      "**Stage names: check the Deploy model section again.**",
    );
    const tableIdx = step5bSection.indexOf('| `"Promote to Prod"` | Promote |');
    const validationIdx = step5bSection.indexOf("actions/workflows");
    const printProgressIdx = step5bSection.indexOf(
      "Print progress on each poll (each loop iteration):",
    );
    expect(stageNamesIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeGreaterThan(-1);
    expect(printProgressIdx).toBeGreaterThan(-1);
    expect(validationIdx).toBeGreaterThan(stageNamesIdx);
    expect(validationIdx).toBeGreaterThan(tableIdx);
    expect(validationIdx).toBeLessThan(printProgressIdx);
  });

  it("on a mismatch, warns naming the missing stage(s) and lists the actual available workflow names", () => {
    const step5bSection = extractStep5bSection(content);
    const lower = step5bSection.toLowerCase();
    expect(lower).toContain("mismatch");
    const mentionsMissing = lower.includes("missing");
    const mentionsNotFound = lower.includes("not found");
    expect(mentionsMissing || mentionsNotFound).toBe(true);
    const mentionsAvailableWorkflows =
      lower.includes("live workflows") || lower.includes("available workflow");
    expect(mentionsAvailableWorkflows).toBe(true);
  });

  it("on a mismatch, falls back to watching all workflow runs by SHA only (unnamed) for the remainder of the 30-minute budget", () => {
    const step5bSection = extractStep5bSection(content);
    const fallbackMatch = step5bSection.match(
      /One or more resolved names are absent[\s\S]*?(?=\n\n\*\*|\n### |$)/,
    );
    expect(fallbackMatch).not.toBeNull();
    const fallbackSection = fallbackMatch?.[0] ?? "";
    expect(fallbackSection).toContain("$SQUASH_SHA");
    expect(fallbackSection.toLowerCase()).toContain("sha only");
    expect(fallbackSection).toContain("30-minute budget");
    expect(fallbackSection).not.toContain("10 minutes");
  });

  it("states a name mismatch alone never sets blocked by itself", () => {
    const step5bSection = extractStep5bSection(content);
    const fallbackMatch = step5bSection.match(
      /One or more resolved names are absent[\s\S]*?(?=\n\n\*\*|\n### |$)/,
    );
    expect(fallbackMatch).not.toBeNull();
    const fallbackSection = fallbackMatch?.[0] ?? "";
    const lower = fallbackSection.toLowerCase();
    expect(lower).toContain("never");
    expect(lower).toContain("blocked");
    const explicitlyScoped =
      lower.includes("alone never sets") || lower.includes("mismatch alone");
    expect(explicitlyScoped).toBe(true);
  });

  it("on a full match, behavior is unchanged — the named three-stage table and print format remain intact", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain('`"Deploy"`');
    expect(step5bSection).toContain('`"Canary"`');
    expect(step5bSection).toContain('`"Promote to Prod"`');
    expect(step5bSection).toContain(
      "[{elapsed}m] Deploy: {status}/{conclusion} | Canary: {status}/{conclusion} | Promote: {status}/{conclusion}",
    );
    expect(step5bSection.toLowerCase()).toContain("no behavior change");
  });
});

describe("deploy.md — Terminal Conditions SHA_ONLY_FALLBACK branch coverage (DWV-1.1)", () => {
  function extractTerminalConditionsSection(md: string): string {
    const match = md.match(/### Terminal Conditions[\s\S]*?(?=\n## )/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("branches on SHA_ONLY_FALLBACK=true before the named-stage checks", () => {
    const section = extractTerminalConditionsSection(content);
    const fallbackIdx = section.indexOf("If `SHA_ONLY_FALLBACK=true`");
    const namedModeIdx = section.indexOf(
      "Otherwise (named-stage mode, the default)",
    );
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(namedModeIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeLessThan(namedModeIdx);
  });

  it("SHA_ONLY_FALLBACK branch covers all-success, any-failure, and budget-exhausted outcomes", () => {
    const section = extractTerminalConditionsSection(content);
    const fallbackMatch = section.match(
      /If `SHA_ONLY_FALLBACK=true`[\s\S]*?(?=\*\*Otherwise)/,
    );
    expect(fallbackMatch).not.toBeNull();
    const fallbackSection = fallbackMatch?.[0] ?? "";
    expect(fallbackSection).toContain("All runs completed successfully");
    expect(fallbackSection).toContain("Any run fails");
    expect(fallbackSection).toContain("Budget exhausted (30 minutes)");
  });

  it("SHA_ONLY_FALLBACK all-success case marks the task deployed and prints the SHA-only handoff line", () => {
    const section = extractTerminalConditionsSection(content);
    const successMatch = section.match(
      /All runs completed successfully[\s\S]*?(?=- \*\*Any run fails)/,
    );
    expect(successMatch).not.toBeNull();
    const successSection = successMatch?.[0] ?? "";
    expect(successSection).toContain('`status: "deployed"` task-store');
    expect(successSection).toContain(
      "Pipeline: SHA-only fallback ({elapsed}m)",
    );
  });

  it("SHA_ONLY_FALLBACK any-failure case sets blocked status, mirroring Step 5c", () => {
    const section = extractTerminalConditionsSection(content);
    const failureMatch = section.match(
      /Any run fails[\s\S]*?(?=- \*\*Budget exhausted)/,
    );
    expect(failureMatch).not.toBeNull();
    const failureSection = failureMatch?.[0] ?? "";
    expect(failureSection.toLowerCase()).toContain("blocked");
  });

  it("SHA_ONLY_FALLBACK budget-exhausted case marks deployed for manual check and prints the pending-at-timeout handoff", () => {
    const section = extractTerminalConditionsSection(content);
    const timeoutMatch = section.match(
      /Budget exhausted \(30 minutes\)\*\* with runs still pending[\s\S]*?(?=Skip the named-stage bullets)/,
    );
    expect(timeoutMatch).not.toBeNull();
    const timeoutSection = timeoutMatch?.[0] ?? "";
    expect(timeoutSection).toContain('`status: "deployed"` (task');
    expect(timeoutSection).toContain(
      "Pipeline: SHA-only fallback (pending at timeout)",
    );
  });

  it("explicitly skips the named-stage bullets in SHA_ONLY_FALLBACK mode", () => {
    const section = extractTerminalConditionsSection(content);
    expect(section).toContain(
      "Skip the named-stage bullets below entirely in this mode",
    );
  });

  it("scopes the SHA_ONLY_FALLBACK budget to this step's own 30 minutes rather than Step 5c's window", () => {
    const section = extractTerminalConditionsSection(content);
    const fallbackMatch = section.match(
      /If `SHA_ONLY_FALLBACK=true`[\s\S]*?(?=\*\*Otherwise)/,
    );
    const fallbackSection = fallbackMatch?.[0] ?? "";
    expect(fallbackSection).toContain("30-minute budget");
    expect(fallbackSection.replace(/\s+/g, " ")).toContain(
      "Step 5c's separate 10-minute window",
    );
  });
});

describe("deploy.md — Monitor-tool polling for Step 5a (MTP-1.1)", () => {
  it("Step 5a's polling implementation names the Monitor tool and drops the old chained-Bash-loop framing", () => {
    const step5aSection = extractStep5aSection(content);
    expect(step5aSection).toContain("Monitor");
    const lower = step5aSection.toLowerCase();
    expect(lower).not.toContain("inline in-bash sleep loop");
    expect(lower).not.toContain("scheduled wakeup mechanism");
  });

  it("Step 5a's polling section does NOT instruct a per-poll ScheduleWakeup call or equivalent backgrounding language", () => {
    const step5aSection = extractStep5aSection(content);
    expect(step5aSection).not.toContain("ScheduleWakeup");
    const lower = step5aSection.toLowerCase();
    expect(lower).not.toContain("wait for the notification");
    expect(lower).not.toContain("run it in the background");
  });

  it("Step 5a explicitly states the implementation is the Monitor tool", () => {
    const step5aSection = extractStep5aSection(content);
    const lower = step5aSection.toLowerCase();
    expect(lower).toContain("implementation");
    expect(lower).toContain("monitor tool");
  });

  it("preserves the 5-minute budget and 30-second poll interval wording in Step 5a", () => {
    const step5aSection = extractStep5aSection(content);
    expect(step5aSection).toContain("5 minutes");
    expect(step5aSection).toContain("30 seconds");
  });

  it("preserves the break-early-on-Deploy-workflow-appearing behavior in Step 5a", () => {
    const step5aSection = extractStep5aSection(content);
    expect(step5aSection.toLowerCase()).toContain("break");
    expect(step5aSection).toContain("Step 5b");
  });

  it("preserves the no-Deploy-workflow-after-5-minutes fallback to Step 5c in Step 5a", () => {
    const step5aSection = extractStep5aSection(content);
    expect(step5aSection).toContain("No Deploy workflow triggered");
    expect(step5aSection).toContain("Step 5c");
  });
});

describe("deploy.md — read target repo's Deploy model before polling (DPS-2.1)", () => {
  it("Step 5a instructs the agent to check the target repo's CLAUDE.md 'Deploy model' section before polling", () => {
    const step5aSection = extractStep5aSection(content);
    expect(step5aSection).toContain("CLAUDE.md");
    expect(step5aSection).toContain("Deploy model");
  });

  it("Step 5a instructs skipping straight to Step 5c when the Deploy model section clearly states there is no pipeline", () => {
    const step5aSection = extractStep5aSection(content);
    const lower = step5aSection.toLowerCase();
    expect(lower).toContain("no deploy pipeline");
    expect(step5aSection).toContain("skip");
    expect(step5aSection).toContain("Step 5c");
  });

  it("Step 5a states the fallback: ambiguous/absent/low-confidence reads fall back to today's unchanged poll behavior — never guess", () => {
    const step5aSection = extractStep5aSection(content);
    const lower = step5aSection.toLowerCase();
    expect(lower).toContain("ambiguous");
    expect(lower).toContain("never guess");
  });

  it("Step 5a's Deploy-model check reads only already-in-context CLAUDE.md — no new file read or tool call", () => {
    const step5aSection = extractStep5aSection(content);
    const lower = step5aSection.toLowerCase();
    expect(lower).toContain("already in");
    expect(lower).toContain("context");
  });

  it("Step 5b instructs using stage names from the Deploy model section when given", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain("Deploy model");
    const lower = step5bSection.toLowerCase();
    expect(lower).toContain("stage name");
  });

  it("Step 5b preserves the literal Deploy/Canary/Promote to Prod defaults for the fallback case", () => {
    const step5bSection = extractStep5bSection(content);
    expect(step5bSection).toContain('`"Deploy"`');
    expect(step5bSection).toContain('`"Canary"`');
    expect(step5bSection).toContain('`"Promote to Prod"`');
    expect(step5bSection).toContain(
      "[{elapsed}m] Deploy: {status}/{conclusion} | Canary: {status}/{conclusion} | Promote: {status}/{conclusion}",
    );
  });
});

function extractStep4bSection(md: string): string {
  const match = md.match(/### 4b\. Squash Merge[\s\S]*?(?=\n### 4c)/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("deploy.md — unconditional admin merge (DSH-1.1)", () => {
  it("Step 4b contains exactly one plain (non-admin) squash merge command", () => {
    const plainMergeCommand = "gh pr merge {pr} --repo {org}/{repo} --squash";
    const occurrences = content.split(plainMergeCommand).length - 1;
    expect(occurrences).toBe(1);
  });

  it("Step 4b's merge command no longer includes --admin", () => {
    const step4bSection = extractStep4bSection(content);
    expect(step4bSection).not.toContain("--admin");
  });

  it("does not contain a --auto merge command anywhere in the file", () => {
    expect(content).not.toContain("--auto");
  });

  it("Step 4b's merge command selection is no longer branched on approval_source", () => {
    const step4bSection = extractStep4bSection(content);
    // No conditional branching by approval source (the two-way GitHub-vs-self-review
    // command selection this task removes) — informational mentions of
    // approval_source are fine, but not a per-branch label distinguishing merge commands.
    expect(step4bSection).not.toContain("**GitHub approval**");
    expect(step4bSection).not.toContain("**Self-review**");
    expect(step4bSection).not.toContain('approval_source == "github"');
    expect(step4bSection).not.toContain('approval_source == "self_review"');
  });
});

describe("deploy.md — branch-protection-block detection on squash merge (RDA-1.1)", () => {
  it("Step 4b captures MERGE_OUTPUT (combined stdout/stderr) and MERGE_EXIT explicitly", () => {
    const step4bSection = extractStep4bSection(content);
    expect(step4bSection).toContain("MERGE_OUTPUT");
    expect(step4bSection).toContain("2>&1");
    expect(step4bSection).toContain("MERGE_EXIT");
    expect(step4bSection).toContain("$?");
  });

  it("Step 4b greps MERGE_OUTPUT case-insensitively for the branch-protection-block phrase", () => {
    const step4bSection = extractStep4bSection(content);
    expect(step4bSection).toContain("grep -qi");
    expect(step4bSection).toContain("base branch policy prohibits the merge");
  });

  // Quote-escaping style varies in this file (single-quoted static JSON vs.
  // double-quoted JSON with interpolated variables, e.g. $MERGE_OUTPUT), so
  // match "status": "blocked" tolerant of either \" or " around the keys/values.
  const BLOCKED_STATUS_RE = /\\?"status\\?"\s*:\s*\\?"blocked\\?"/g;

  function countBlockedStatusOccurrences(section: string): number {
    return (section.match(BLOCKED_STATUS_RE) ?? []).length;
  }

  function firstBlockedStatusIndex(section: string, fromIndex = 0): number {
    BLOCKED_STATUS_RE.lastIndex = 0;
    const re = new RegExp(BLOCKED_STATUS_RE);
    re.lastIndex = fromIndex;
    const match = re.exec(section);
    return match ? match.index : -1;
  }

  it("branch-protection-block case sets status: blocked with a blockedReason naming the self-review/native-approval gap", () => {
    const step4bSection = extractStep4bSection(content);
    const blockIdx = step4bSection.indexOf(
      "base branch policy prohibits the merge",
    );
    expect(blockIdx).toBeGreaterThan(-1);
    const blockSection = step4bSection.slice(blockIdx, blockIdx + 1500);
    expect(countBlockedStatusOccurrences(blockSection)).toBeGreaterThanOrEqual(
      1,
    );
    expect(blockSection).toContain("blockedReason");
    const lower = blockSection.toLowerCase();
    expect(lower).toContain("self-review");
    expect(lower).toContain("native");
    const mentionsFix =
      lower.includes("bypass actor") || lower.includes("real approval");
    expect(mentionsFix).toBe(true);
  });

  it("generic merge-failure case (non-branch-protection) also sets status: blocked with a distinct reason", () => {
    const step4bSection = extractStep4bSection(content);
    // The generic failure branch's blocked-update PATCH must be present and distinct
    // from the branch-protection-block PATCH — check both blocked-status PATCHes exist.
    const blockedOccurrences = countBlockedStatusOccurrences(step4bSection);
    expect(blockedOccurrences).toBeGreaterThanOrEqual(2);
    expect(step4bSection).toContain("Squash merge failed");
  });

  it("both new blocked-status updates release the pre-merge claim first", () => {
    const step4bSection = extractStep4bSection(content);
    const releaseIdx1 = step4bSection.indexOf("/prs/$PR_RECORD_ID/release");
    expect(releaseIdx1).toBeGreaterThan(-1);
    const branchProtectionBlockIdx = step4bSection.indexOf(
      "base branch policy prohibits the merge",
    );
    const firstBlockedIdx = firstBlockedStatusIndex(step4bSection);
    expect(firstBlockedIdx).toBeGreaterThan(-1);
    expect(releaseIdx1).toBeLessThan(firstBlockedIdx);
    expect(branchProtectionBlockIdx).toBeLessThan(firstBlockedIdx);

    const secondBlockedIdx = firstBlockedStatusIndex(
      step4bSection,
      firstBlockedIdx + 1,
    );
    expect(secondBlockedIdx).toBeGreaterThan(-1);
    const releaseIdx2 = step4bSection.lastIndexOf(
      "/prs/$PR_RECORD_ID/release",
      secondBlockedIdx,
    );
    expect(releaseIdx2).toBeGreaterThan(-1);
    expect(releaseIdx2).toBeLessThan(secondBlockedIdx);
  });

  it("the non-zero-exit check happens before the existing 60-second MERGED-state poll", () => {
    const step4bSection = extractStep4bSection(content);
    const mergeExitIdx = step4bSection.indexOf("MERGE_EXIT");
    const pollIdx = step4bSection.indexOf("Poll for the merge to complete");
    expect(mergeExitIdx).toBeGreaterThan(-1);
    expect(pollIdx).toBeGreaterThan(-1);
    expect(mergeExitIdx).toBeLessThan(pollIdx);
  });

  it("rationale prose no longer claims --admin bypasses branch protection unconditionally", () => {
    const step4bSection = extractStep4bSection(content);
    expect(step4bSection).not.toContain(
      "bypasses branch protection (including",
    );
    expect(step4bSection.toLowerCase()).not.toContain(
      "already-authorized\nbypass rather than circumventing",
    );
  });

  it("rationale prose describes the new deferral-to-branch-protection behavior and names the bypass_actors exception", () => {
    const step4bSection = extractStep4bSection(content);
    const lower = step4bSection.toLowerCase().replace(/\s+/g, " ");
    expect(lower).toContain("defer");
    expect(step4bSection).toContain("bypass_actors");
    expect(step4bSection).toContain("18495740");
    expect(lower).toContain("other repos");
  });
});

describe("deploy.md — PR-level blocked escalation on deploy-only-mode failures (PRB-3.2)", () => {
  // The 6 escalation/failure sites that must now PATCH /prs/$PR_RECORD_ID with
  // blocked:true + blockedReason when TASK_ID is empty (deploy-only mode), instead of
  // silently skipping. Each is identified by a unique anchor string near its bash
  // block, and the original TASK_ID-non-empty PATCH body that must remain unchanged.
  const sites = [
    {
      name: "Post-merge CI failed (Step 5c)",
      anchor: "Post-merge CI failed — {name}",
      taskBody: '\\"status\\": \\"blocked\\", \\"note\\": \\"Post-merge CI failed — run ID: {id}\\"',
    },
    {
      name: "Post-merge CI still pending after 10 minutes (Step 5c budget exhausted)",
      anchor: "Post-merge CI still pending after 10 minutes",
      taskBody:
        '\\"status\\": \\"deployed\\", \\"deployedAt\\": \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"',
    },
    {
      name: "Deploy stage failed (Step 5b terminal conditions)",
      anchor: "Deploy stage failed — nothing reached prod.",
      taskBody: '\\"status\\": \\"blocked\\", \\"note\\": \\"Deploy stage failed — run ID: {id}\\"',
    },
    {
      name: "Canary passed but Promote skipped (Step 5b terminal conditions)",
      anchor: "Canary passed but Promote was skipped.",
      taskBody: '"status": "blocked", "note": "canary_blocked: Promote skipped after canary success"',
    },
    {
      name: "Pipeline timeout after 30 minutes (Step 5b terminal conditions)",
      anchor: "Pipeline timeout after 30 minutes.",
      taskBody: '"status": "blocked", "note": "Pipeline timeout after 30 minutes"',
    },
    {
      name: "Canary failed — revert PR opened (Step 6)",
      anchor: "CANARY FAILED — REVERT PR OPENED",
      taskBody:
        '\\"status\\": \\"blocked\\", \\"blockedAt\\": \\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\", \\"note\\": \\"Canary failed after deploy. Revert PR opened: {revert_pr_url}\\"',
    },
  ];

  function extractSiteSection(anchor: string): string {
    const anchorIdx = content.indexOf(anchor);
    expect(anchorIdx).toBeGreaterThan(-1);
    // Grab a generous window after the anchor covering the print block + PATCH bash block.
    return content.slice(anchorIdx, anchorIdx + 1200);
  }

  for (const site of sites) {
    describe(site.name, () => {
      it("PATCHes /prs/$PR_RECORD_ID with blocked:true + blockedReason when TASK_ID is empty", () => {
        const section = extractSiteSection(site.anchor);
        expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/prs/$PR_RECORD_ID");
        expect(section).toContain("blocked");
        expect(section).toContain("true");
        expect(section).toContain("blockedReason");
      });

      it("still PATCHes /tasks/$TASK_ID with the original unchanged body when TASK_ID is non-empty", () => {
        const section = extractSiteSection(site.anchor);
        expect(section).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/$TASK_ID");
        expect(section).toContain(site.taskBody);
      });

      it("branches explicitly on whether TASK_ID is set (if/else), not a blanket skip", () => {
        const section = extractSiteSection(site.anchor);
        const hasConditional =
          /if\s*\[\s*-n\s*"\$TASK_ID"\s*\]/.test(section) ||
          /if\s*\[\s*-z\s*"\$TASK_ID"\s*\]/.test(section);
        expect(hasConditional).toBe(true);
      });
    });
  }

  it("does not touch the 4 success-path deploy-only-mode sites (task merged, task deploying, post-merge-CI-passed, final handoff)", () => {
    // Task merged (Step 4b)
    const mergedIdx = content.indexOf("Mark the task merged via the task store");
    expect(mergedIdx).toBeGreaterThan(-1);
    const mergedSection = content.slice(mergedIdx, mergedIdx + 400);
    expect(mergedSection).not.toContain("/prs/$PR_RECORD_ID\"");
    expect(mergedSection).not.toContain('"hitl"');
    expect(mergedSection).not.toContain('"blocked": true');

    // Task deploying (Step 5 intro)
    const deployingIdx = content.indexOf("is the deploy duration). Skip if in deploy-only mode:");
    expect(deployingIdx).toBeGreaterThan(-1);
    const deployingSection = content.slice(deployingIdx, deployingIdx + 400);
    expect(deployingSection).not.toContain('"hitl"');
    expect(deployingSection).not.toContain('"blocked": true');

    // Post-merge CI passed -> deployed (Step 5c success)
    const ciPassedIdx = content.indexOf("Post-merge CI passed ({elapsed}m)");
    expect(ciPassedIdx).toBeGreaterThan(-1);
    const ciPassedSection = content.slice(ciPassedIdx, ciPassedIdx + 400);
    expect(ciPassedSection).not.toContain('"hitl"');
    expect(ciPassedSection).not.toContain('"blocked": true');

    // Final handoff -> deployed (Step 8b)
    const handoffIdx = content.indexOf("Skip if no task was found (deploy-only mode):");
    expect(handoffIdx).toBeGreaterThan(-1);
    const handoffSection = content.slice(handoffIdx, handoffIdx + 400);
    expect(handoffSection).not.toContain('"hitl"');
    expect(handoffSection).not.toContain('"blocked": true');
  });
});

describe("deploy.md — Step 2b bundle gate skip-reason marker (DBV-1.1)", () => {
  function extractStep2bSection(md: string): string {
    const match = md.match(
      /### 2b\. Bundle Completeness Gate[\s\S]*?(?=\n---)/,
    );
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("Step 2b's bundle-gate-block text includes [silent] and a [skip-reason:deploy:deferred:bundle-incomplete: marker", () => {
    const step2bSection = extractStep2bSection(content);
    expect(step2bSection).toContain("[silent]");
    expect(step2bSection).toContain(
      "[skip-reason:deploy:deferred:bundle-incomplete:",
    );
  });

  it("Step 2b's skip-reason marker interpolates {HEAD_BRANCH}, matching the placeholder style used elsewhere in this file", () => {
    const step2bSection = extractStep2bSection(content);
    expect(step2bSection).toContain(
      "[skip-reason:deploy:deferred:bundle-incomplete:{HEAD_BRANCH}]",
    );
  });

  it("does not use the old pre-taxonomy skip-reason tag (deploy:bundle-incomplete without the deferred segment)", () => {
    const step2bSection = extractStep2bSection(content);
    expect(step2bSection).not.toContain(
      "[skip-reason:deploy:bundle-incomplete:",
    );
  });

  it("emits the skip-reason marker alongside [silent] in the same 'Stop here' instruction", () => {
    const step2bSection = extractStep2bSection(content);
    const stopHereIdx = step2bSection.indexOf("Stop here");
    expect(stopHereIdx).toBeGreaterThan(-1);
    const silentIdx = step2bSection.indexOf("[silent]", stopHereIdx);
    const skipReasonIdx = step2bSection.indexOf(
      "[skip-reason:deploy:deferred:bundle-incomplete:{HEAD_BRANCH}]",
      stopHereIdx,
    );
    expect(silentIdx).toBeGreaterThan(-1);
    expect(skipReasonIdx).toBeGreaterThan(-1);
  });

  it("does not require a specific ordering between [skip-reason:...] and [silent] — markers.ts parses both regardless of position", () => {
    // parseMarkers() strips [skip-reason:...] before checking [silent]'s
    // end-anchor, so the two markers can appear in either order in the raw
    // text without breaking [silent] detection (see markers.unit.test.ts's
    // order-independence cases).
    const step2bSection = extractStep2bSection(content);
    expect(step2bSection).not.toContain(
      "must come first",
    );
    expect(step2bSection).toContain("does not matter");
  });
});

describe("deploy.md — self-review approval fallback (RHA-1.1)", () => {
  it("Step 3a falls back to the self-review path unconditionally when reviewDecision is not APPROVED", () => {
    const step3aSection = extractStep3aSection(content);
    // The self-review fallback must sit directly under the not-APPROVED branch, no
    // longer gated behind any prior conditional branch.
    expect(step3aSection).toContain(
      "**If `reviewDecision` is not `\"APPROVED\"`**",
    );
    expect(step3aSection).toContain("allow_self_review");
    expect(step3aSection).toContain('sub("^\\\\*+";"")');
    expect(step3aSection).toContain('startsWith("APPROVE")');
  });

  it("prints the clean-APPROVE proceed message and the not-approved stop message on the fallback path", () => {
    const step3aSection = extractStep3aSection(content);
    expect(step3aSection).toContain(
      "No GitHub approval. Proceeding on clean APPROVE review.",
    );
    expect(step3aSection).toContain(
      "Pre-flight failed: PR #{pr} is not approved.",
    );
  });

  it("Step 4b's merge command remains the single plain (non-admin) squash merge", () => {
    const plainMergeCommand = "gh pr merge {pr} --repo {org}/{repo} --squash";
    const occurrences = content.split(plainMergeCommand).length - 1;
    expect(occurrences).toBe(1);
    const step4bSection = extractStep4bSection(content);
    expect(step4bSection).not.toContain("--admin");
  });
});

describe("deploy.md — Step 3b: verify all checks are green (CGC-1.1)", () => {
  it("verifies all checks are green on the PR head commit via the actions/runs API", () => {
    const section = extractStep3bSection(content);
    expect(section).toContain("headRefOid");
    expect(section).toContain("actions/runs");
    expect(section).toContain("head_sha");
  });

  it("does not query gh pr view for statusCheckRollup / CheckRun / StatusContext fields", () => {
    const section = extractStep3bSection(content);
    expect(section).not.toContain("json headRefOid,statusCheckRollup");
    expect(section).not.toContain("CheckRun");
    expect(section).not.toContain("StatusContext");
  });

  it("does not filter workflow runs by a hardcoded CI workflow name", () => {
    const section = extractStep3bSection(content);
    expect(section).not.toContain('ascii_downcase == "ci"');
  });

  it("groups runs by workflow name and keeps only the latest run per name", () => {
    const section = extractStep3bSection(content);
    expect(section).toContain("group_by(.name)");
    expect(section).toContain("max_by(.created_at)");
  });

  it("fails with a clear message when not all checks are green", () => {
    const section = extractStep3bSection(content);
    expect(section).toContain("not all checks are green");
  });
});
