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
