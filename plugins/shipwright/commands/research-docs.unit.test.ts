import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RESEARCH_DOCS_MD_PATH = join(import.meta.dir, "research-docs.md");

let content: string;

beforeAll(() => {
  content = readFileSync(RESEARCH_DOCS_MD_PATH, "utf-8");
});

describe("research-docs.md — auto mode detection", () => {
  it("detects --auto flag in $ARGUMENTS to trigger auto mode", () => {
    expect(content).toContain("--auto");
    expect(content).toContain("$ARGUMENTS");
  });

  it("branches on --auto: auto flow vs interactive flow", () => {
    const hasAutoCheck =
      content.includes("contains") ||
      content.includes("includes") ||
      content.includes("--auto");
    const hasInteractiveMode = content.toLowerCase().includes("interactive");
    expect(hasAutoCheck).toBe(true);
    expect(hasInteractiveMode).toBe(true);
  });
});

describe("research-docs.md — auto mode sync anchor", () => {
  it("reads state/docs-last-synced.json for the last-synced SHA", () => {
    expect(content).toContain("state/docs-last-synced.json");
  });

  it("treats absent sync anchor as full audit scope", () => {
    const hasAbsentFallback =
      content.includes("file doesn't exist") ||
      content.includes("does not exist") ||
      content.includes("absent") ||
      content.includes("not found") ||
      content.includes("missing");
    expect(hasAbsentFallback).toBe(true);
  });

  it("writes state/docs-last-synced.json with sha and timestamp after auto run", () => {
    const syncAnchorIdx = content.indexOf("state/docs-last-synced.json");
    const afterWriteIdx = content.lastIndexOf("state/docs-last-synced.json");
    // Must appear at least twice: read and write
    expect(syncAnchorIdx).not.toBe(afterWriteIdx);
    expect(content).toContain('"sha"');
    expect(content).toContain('"timestamp"');
  });
});

describe("research-docs.md — auto mode scoping", () => {
  it("uses git diff against anchor SHA to find changed source files", () => {
    const hasGitDiff =
      content.includes("git diff") || content.includes("git-diff");
    expect(hasGitDiff).toBe(true);
  });

  it("filters docs to only those referencing changed files", () => {
    const hasFiltering =
      content.includes("filter") ||
      content.includes("candidate") ||
      content.includes("overlap") ||
      content.includes("grep");
    expect(hasFiltering).toBe(true);
  });
});

describe("research-docs.md — auto mode doc updates", () => {
  it("updates stale docs via doc-refresh-recipe.md Part 2 without user confirmation", () => {
    expect(content).toContain("doc-refresh-recipe.md");
    const hasPartTwo = content.includes("Part 2") || content.includes("part 2");
    expect(hasPartTwo).toBe(true);
  });

  it("updates CLAUDE.md Reference entries automatically in auto mode", () => {
    const claudeMdIdx = content.indexOf("CLAUDE.md");
    expect(claudeMdIdx).toBeGreaterThan(-1);
    // CLAUDE.md appears in both auto and interactive steps
    const hasCLAUDEmdMultiple = content.split("CLAUDE.md").length > 2;
    expect(hasCLAUDEmdMultiple).toBe(true);
  });
});

describe("research-docs.md — auto mode follow-on tasks", () => {
  it("creates follow-on tasks for missing docs via task store bulk API", () => {
    expect(content).not.toContain("task_store.ts");
    const hasBulkInsert =
      content.includes("/tasks/bulk") &&
      content.includes("SHIPWRIGHT_TASK_STORE_URL");
    expect(hasBulkInsert).toBe(true);
  });

  it("does NOT generate docs for missing modules in auto mode", () => {
    // Missing docs should produce tasks, not generated files
    const hasMissingTasksOut =
      (content.includes("missing") || content.includes("Missing")) &&
      (content.includes("task") || content.includes("append"));
    expect(hasMissingTasksOut).toBe(true);
  });
});

describe("research-docs.md — auto mode no prompts", () => {
  it("auto mode prints a non-interactive summary (no Proceed? gates)", () => {
    // The "Proceed?" gate must ONLY appear in the interactive section
    const interactiveIdx = content.toLowerCase().indexOf("interactive mode");
    const proceedIdx = content.indexOf("Proceed?");
    // If "Proceed?" exists, it must come after the Interactive Mode heading
    if (proceedIdx >= 0 && interactiveIdx >= 0) {
      expect(proceedIdx).toBeGreaterThan(interactiveIdx);
    }
  });

  it("auto mode ends with a non-interactive summary section", () => {
    const hasSummary =
      content.includes("Summary") ||
      content.includes("summary") ||
      content.includes("DONE") ||
      content.includes("Auto run complete");
    expect(hasSummary).toBe(true);
  });
});

describe("research-docs.md — auto mode per-repo iteration", () => {
  it("references resolveRepoDirs / check-helpers.ts as the repo resolution mechanism", () => {
    expect(content).toContain("resolveRepoDirs");
    expect(content).toContain("check-helpers.ts");
  });

  it("documents parsing the repo list from the precheck-driven invoking prompt", () => {
    expect(content).toContain("check-docs-freshness.ts");
    const hasPrecheckLanguage =
      content.includes("preCheck") || content.includes("precheck");
    expect(hasPrecheckLanguage).toBe(true);
    const hasPromptParsing =
      content.includes("Parse the repo names") ||
      content.includes("invoking prompt");
    expect(hasPromptParsing).toBe(true);
  });

  it("documents a fallback that iterates repos/* directly when run manually", () => {
    const hasFallback =
      content.includes("Fallback") || content.includes("fallback");
    expect(hasFallback).toBe(true);
    expect(content).toContain("repos/*");
  });

  it("documents cd-ing into repos/{dirname} to scope Steps A1-A8 per repo", () => {
    const hasCdStep =
      content.includes("cd") && content.includes("repos/{dirname}");
    expect(hasCdStep).toBe(true);
    expect(content).toContain("Steps A1-A8");
  });

  it("documents skipping a repo with no docs/ directory cleanly (no anchor read/write)", () => {
    const hasSkipLanguage =
      content.includes("skipped cleanly") ||
      content.includes("is skipped cleanly") ||
      content.includes("skip cleanly");
    expect(hasSkipLanguage).toBe(true);
    expect(content).toContain("do not create `docs/`");
  });

  it("documents each repo's sync anchor being written independently", () => {
    const hasIndependentAnchor =
      content.includes("independently") &&
      content.includes("state/docs-last-synced.json");
    expect(hasIndependentAnchor).toBe(true);
  });

  it("Step A9 aggregates a per-repo summary across all processed repos", () => {
    const stepA9Idx = content.indexOf("### Step A9");
    expect(stepA9Idx).toBeGreaterThan(-1);
    const stepA9Section = content.slice(stepA9Idx, stepA9Idx + 1500);
    expect(stepA9Section).toContain("Repos processed");
    expect(stepA9Section.toLowerCase()).toContain("aggregat");
  });
});

describe("research-docs.md — interactive mode preservation", () => {
  it("interactive flow still has Wait for user confirmation gate", () => {
    const hasGate =
      content.includes("Wait for user confirmation") ||
      content.includes("Proceed?");
    expect(hasGate).toBe(true);
  });

  it("interactive flow still has all 8 original steps", () => {
    // Check that the original steps are still present
    expect(content).toContain("Step 1");
    expect(content).toContain("Step 2");
    expect(content).toContain("Step 3");
    expect(content).toContain("Step 4");
    expect(content).toContain("Step 5");
    expect(content).toContain("Step 6");
    expect(content).toContain("Step 7");
    expect(content).toContain("Step 8");
  });

  it("interactive flow still audits the full project when no $ARGUMENTS", () => {
    expect(content).toContain("audit the entire project");
  });
});

describe("research-docs.md — cross-cutting concerns checklist", () => {
  const CONCERN_CATEGORIES = [
    "business-domain/state-model",
    "authorization/access-control",
    "error-handling conventions",
    "sensitive-data handling",
    "secrets/credential rotation",
    "logging/tracing/observability wiring",
    "internal/third-party service dependencies",
  ];

  it("names all seven cross-cutting concern categories", () => {
    for (const category of CONCERN_CATEGORIES) {
      expect(content).toContain(category);
    }
  });

  it("requires verifying a concern is materially present before proposing it", () => {
    expect(content.toLowerCase()).toContain("materially present");
    // Must describe checking real content, not a blind checklist dump
    const hasRealContentLanguage =
      content.includes("authz middleware") ||
      content.includes("error class hierarchy") ||
      content.includes("logging SDK init");
    expect(hasRealContentLanguage).toBe(true);
  });

  it("skips a concern category with no real content instead of proposing it blindly", () => {
    const hasSkipLanguage =
      content.includes("never propose a category with no real content") ||
      content.includes("no real content to write") ||
      content.includes("not proposed") ||
      content.includes("do not propose");
    expect(hasSkipLanguage).toBe(true);
  });

  it("adds a CONCERNS: block to the DOCS AUDIT template, distinct from MISSING:", () => {
    const auditIdx = content.indexOf("DOCS AUDIT");
    expect(auditIdx).toBeGreaterThan(-1);
    const proceedIdx = content.indexOf("Proceed?", auditIdx);
    expect(proceedIdx).toBeGreaterThan(auditIdx);
    const auditSection = content.slice(auditIdx, proceedIdx);
    expect(auditSection).toContain("MISSING:");
    expect(auditSection).toContain("CONCERNS:");
    // CONCERNS: must be a distinct block, not a rename/merge of MISSING:
    expect(auditSection.indexOf("MISSING:")).not.toBe(
      auditSection.indexOf("CONCERNS:"),
    );
    // Both blocks flow into the same Proceed? gate
    expect(auditSection.indexOf("CONCERNS:")).toBeLessThan(proceedIdx);
  });

  it("Step A7 unions a verified concern into the same missing-docs task payload, titled 'Document {concern} conventions'", () => {
    const stepA7Idx = content.indexOf("### Step A7");
    expect(stepA7Idx).toBeGreaterThan(-1);
    const nextStepIdx = content.indexOf("### Step A8");
    expect(nextStepIdx).toBeGreaterThan(stepA7Idx);
    const stepA7Section = content.slice(stepA7Idx, nextStepIdx);
    expect(stepA7Section).toContain("Document {concern} conventions");
    expect(stepA7Section).toContain("docs-freshness-cron");
    const hasUnionLanguage =
      stepA7Section.includes("union") || stepA7Section.includes("unioned");
    expect(hasUnionLanguage).toBe(true);
    // Scoped to CHANGED_FILES, same as A7's existing structural check
    expect(stepA7Section).toContain("CHANGED_FILES");
  });
});

describe("research-docs.md — quality pass", () => {
  it("Step 6.5 exists between Step 6 and Step 7 and documents canonical-source duplication (6.5a)", () => {
    const step6_5Idx = content.indexOf("## Step 6.5: Quality Pass");
    expect(step6_5Idx).toBeGreaterThan(-1);
    const step6Idx = content.indexOf("## Step 6: Update Stale Docs");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    expect(step6Idx).toBeGreaterThan(-1);
    expect(step7Idx).toBeGreaterThan(-1);
    expect(step6_5Idx).toBeGreaterThan(step6Idx);
    expect(step6_5Idx).toBeLessThan(step7Idx);

    const section = content.slice(step6_5Idx, step7Idx);
    expect(section).toContain("6.5a");
    expect(section.toLowerCase()).toContain("canonical");
    expect(section.toLowerCase()).toContain("pointer");
  });

  it("Step 6.5b documents literal/prose mismatch flagged with the specific line", () => {
    const step6_5Idx = content.indexOf("## Step 6.5: Quality Pass");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_5Idx, step7Idx);
    expect(section).toContain("6.5b");
    expect(section.toLowerCase()).toContain("literal");
    expect(section.toLowerCase()).toContain("prose");
    expect(section.toLowerCase()).toContain("mismatch");
    expect(section.toLowerCase()).toContain("line");
  });

  it("Step 6.5c documents mechanism-honesty check flagged as low-confidence", () => {
    const step6_5Idx = content.indexOf("## Step 6.5: Quality Pass");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_5Idx, step7Idx);
    expect(section).toContain("6.5c");
    expect(section.toLowerCase()).toContain("mechanism");
    expect(section.toLowerCase()).toContain("low-confidence");
  });

  it("interactive quality pass gates on user confirmation — never automatic rewrites", () => {
    const step6_5Idx = content.indexOf("## Step 6.5: Quality Pass");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_5Idx, step7Idx);
    const hasNeverAutomaticLanguage =
      section.toLowerCase().includes("never automatic") ||
      section.toLowerCase().includes("proposal");
    expect(hasNeverAutomaticLanguage).toBe(true);
    expect(section).toContain("Proceed?");
  });

  it("Step 6.5 only runs against docs drafted in Step 5 or updated in Step 6, not untouched docs", () => {
    const step6_5Idx = content.indexOf("## Step 6.5: Quality Pass");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_5Idx, step7Idx);
    expect(section).toContain("Step 5");
    expect(section).toContain("Step 6");
    expect(section.toLowerCase()).toContain("untouched");
  });

  it("Step A5.5 exists immediately after Step A5 and before Step A6", () => {
    const stepA5Idx = content.indexOf("### Step A5: Update Stale Docs");
    const stepA5_5Idx = content.indexOf("### Step A5.5: Auto Mode Quality Pass");
    const stepA6Idx = content.indexOf("### Step A6: Update CLAUDE.md References");
    expect(stepA5Idx).toBeGreaterThan(-1);
    expect(stepA5_5Idx).toBeGreaterThan(-1);
    expect(stepA6Idx).toBeGreaterThan(-1);
    expect(stepA5_5Idx).toBeGreaterThan(stepA5Idx);
    expect(stepA5_5Idx).toBeLessThan(stepA6Idx);
  });

  it("Step A5.5 files task-store tasks per hit (not edits) via the existing /tasks/bulk mechanism", () => {
    const stepA5_5Idx = content.indexOf("### Step A5.5: Auto Mode Quality Pass");
    const stepA6Idx = content.indexOf("### Step A6: Update CLAUDE.md References");
    const section = content.slice(stepA5_5Idx, stepA6Idx);

    expect(section).toContain("/tasks/bulk");
    expect(section.toLowerCase()).toContain("session");
    expect(section).toContain("docs-freshness-cron");
    expect(section.toLowerCase()).toContain("never an auto-edit");

    // Must reuse the same endpoint Step A7 documents — not invent a new one
    const stepA7Idx = content.indexOf("### Step A7: Task Out Missing Docs");
    const stepA7End = content.indexOf("### Step A8: Write Sync Anchor");
    const stepA7Section = content.slice(stepA7Idx, stepA7End);
    expect(stepA7Section).toContain("/tasks/bulk");

    // No second/different bulk-like endpoint introduced
    const bulkEndpointMatches = content.match(/\/tasks\/[a-zA-Z-]+/g) ?? [];
    const uniqueBulkEndpoints = new Set(
      bulkEndpointMatches.filter((m) => m.includes("bulk")),
    );
    expect(uniqueBulkEndpoints.size).toBe(1);
    expect(uniqueBulkEndpoints.has("/tasks/bulk")).toBe(true);
  });

  it("Step A5.5 documents the three quality-flag task titles", () => {
    const stepA5_5Idx = content.indexOf("### Step A5.5: Auto Mode Quality Pass");
    const stepA6Idx = content.indexOf("### Step A6: Update CLAUDE.md References");
    const section = content.slice(stepA5_5Idx, stepA6Idx);

    expect(section).toContain("canonical-source duplication");
    expect(section).toContain("literal/prose mismatch");
    expect(section).toContain("convention missing named mechanism");
    expect(section).toContain('layer: "CLI"');
    expect(section).toContain('session: "docs-freshness-cron"');
  });

  it("Step A9's summary template includes a Quality flags tasked line", () => {
    const stepA9Idx = content.indexOf("### Step A9");
    expect(stepA9Idx).toBeGreaterThan(-1);
    const stepA9Section = content.slice(stepA9Idx, stepA9Idx + 2000);
    expect(stepA9Section).toContain("Quality flags tasked");
  });
});

describe("research-docs.md — size governance", () => {
  it("Step 6.6 exists between Step 6.5 and Step 7", () => {
    const step6_5Idx = content.indexOf("## Step 6.5: Quality Pass");
    const step6_6Idx = content.indexOf("## Step 6.6: Size Governance");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    expect(step6_5Idx).toBeGreaterThan(-1);
    expect(step6_6Idx).toBeGreaterThan(-1);
    expect(step7Idx).toBeGreaterThan(-1);
    expect(step6_6Idx).toBeGreaterThan(step6_5Idx);
    expect(step6_6Idx).toBeLessThan(step7Idx);
  });

  it("Step 6.6 runs against docs updated in Step 6, after Step 6.5's edits are applied", () => {
    const step6_6Idx = content.indexOf("## Step 6.6: Size Governance");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_6Idx, step7Idx);
    expect(section).toContain("Step 6");
    expect(section).toContain("Step 6.5");
  });

  it("Step 6.6 defines concrete soft (150) and hard (200) line thresholds", () => {
    const step6_6Idx = content.indexOf("## Step 6.6: Size Governance");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_6Idx, step7Idx);
    expect(section).toContain("150");
    expect(section).toContain("200");
  });

  it("Step 6.6 documents the under-threshold case as a no-op — behaves as today", () => {
    const step6_6Idx = content.indexOf("## Step 6.6: Size Governance");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_6Idx, step7Idx);
    const hasNoOpLanguage =
      section.toLowerCase().includes("no-op") ||
      section.toLowerCase().includes("no action") ||
      section.toLowerCase().includes("behaves as before") ||
      section.toLowerCase().includes("behaves exactly as before");
    expect(hasNoOpLanguage).toBe(true);
  });

  it("Step 6.6 documents the over-threshold split proposal — never automatic, gated on confirmation", () => {
    const step6_6Idx = content.indexOf("## Step 6.6: Size Governance");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_6Idx, step7Idx);
    expect(section.toLowerCase()).toContain("split");
    expect(section.toLowerCase()).toContain("sub-topic");
    expect(section.toLowerCase()).toContain("never automatic");
    expect(section).toContain("Proceed?");
    expect(section.toLowerCase()).toContain("wait for confirmation");
  });

  it("Step 6.6 reuses Step 4's detected naming pattern for the new sub-topic doc filename", () => {
    const step6_6Idx = content.indexOf("## Step 6.6: Size Governance");
    const step7Idx = content.indexOf("## Step 7: Update CLAUDE.md Reference");
    const section = content.slice(step6_6Idx, step7Idx);
    expect(section).toContain("Step 4");
  });

  it("Step A5.5 also checks resulting line count against Step 6.6's hard threshold", () => {
    const stepA5_5Idx = content.indexOf("### Step A5.5: Auto Mode Quality Pass");
    const stepA6Idx = content.indexOf("### Step A6: Update CLAUDE.md References");
    const section = content.slice(stepA5_5Idx, stepA6Idx);

    expect(section.toLowerCase()).toContain("line count");
    const referencesStep6_6 =
      section.includes("Step 6.6") || section.includes("Size Governance");
    expect(referencesStep6_6).toBe(true);
  });

  it("Step A5.5 files a Split proposal task via /tasks/bulk, never creates a file", () => {
    const stepA5_5Idx = content.indexOf("### Step A5.5: Auto Mode Quality Pass");
    const stepA6Idx = content.indexOf("### Step A6: Update CLAUDE.md References");
    const section = content.slice(stepA5_5Idx, stepA6Idx);

    expect(section).toContain("Split {doc} — exceeds");
    expect(section).toContain("/tasks/bulk");
    expect(section).toContain('layer: "CLI"');
    expect(section).toContain('session: "docs-freshness-cron"');

    // Still exactly one distinct bulk-like endpoint in the whole file
    const bulkEndpointMatches = content.match(/\/tasks\/[a-zA-Z-]+/g) ?? [];
    const uniqueBulkEndpoints = new Set(
      bulkEndpointMatches.filter((m) => m.includes("bulk")),
    );
    expect(uniqueBulkEndpoints.size).toBe(1);
    expect(uniqueBulkEndpoints.has("/tasks/bulk")).toBe(true);
  });

  it("Step A9's summary template includes a Split proposals tasked line, after Quality flags tasked", () => {
    const stepA9Idx = content.indexOf("### Step A9");
    expect(stepA9Idx).toBeGreaterThan(-1);
    const stepA9Section = content.slice(stepA9Idx, stepA9Idx + 2000);
    expect(stepA9Section).toContain("Split proposals tasked");

    const qualityIdx = stepA9Section.indexOf("Quality flags tasked");
    const splitIdx = stepA9Section.indexOf("Split proposals tasked");
    expect(qualityIdx).toBeGreaterThan(-1);
    expect(splitIdx).toBeGreaterThan(qualityIdx);
  });
});
