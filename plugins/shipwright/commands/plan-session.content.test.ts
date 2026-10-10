import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLAN_SESSION_MD_PATH = join(import.meta.dir, "plan-session.md");

let content: string;

beforeAll(() => {
  content = readFileSync(PLAN_SESSION_MD_PATH, "utf-8");
});

function extractStep5_5Section(md: string): string {
  const match = md.match(/## Step 5\.5: HITL Detection[\s\S]*?(?=\n## Step 6: Write to Queue)/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function extractStep6bSection(md: string): string {
  const match = md.match(/\*\*Step 6b — Write tasks to the store:\*\*[\s\S]*$/);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("plan-session.md — Step 5 task titles are Conventional-Commit subjects (PTP-1.1)", () => {
  it("requires `type: verb-first summary` with the allowed type list and selection guidance", () => {
    const line = content.split("\n").find((l) => l.startsWith("- **Title**")) ?? "";
    expect(line).toContain("Conventional-Commit subject");
    expect(line).toContain("`type: verb-first summary`");
    for (const t of ["feat", "fix", "perf", "revert", "docs", "refactor", "test", "build", "ci", "chore"]) {
      expect(line).toContain(`\`${t}\``);
    }
    expect(line).toContain("docs-only → `docs`");
    expect(line).toContain("CI/workflow → `ci`");
  });

  it("uses the new form in the task JSON template", () => {
    expect(content).toContain('"title": "feat: verb-first summary"');
  });
});

describe("plan-session.md — Step 5.5 is a 2-way HITL classification (RHA-1.2)", () => {
  it("explicitly names the Type A classification", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("Type A");
  });

  it("defines Type A as no real code/acceptance-criteria diff, human executes commands directly", () => {
    const section = extractStep5_5Section(content);
    const typeAIdx = section.indexOf("Type A");
    expect(typeAIdx).toBeGreaterThan(-1);
    const typeASection = section.slice(typeAIdx);
    const lower = typeASection.toLowerCase();
    expect(lower).toContain("no real code");
    expect(lower).toMatch(/acceptance.criteria diff/);
    expect(lower).toContain("human executes");
  });

  it("Type A sets hitl:true and injects a Human steps section", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("hitl: true");
    expect(section).toContain("## Human steps");
  });

  it("documents the neither case as unchanged: hitl:false, no special handling", () => {
    const section = extractStep5_5Section(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("neither");
    expect(section).toContain("hitl: false");
  });

  it("How to Flag a Matched Task section covers Type A flagging instructions", () => {
    const section = extractStep5_5Section(content);
    const howToFlagIdx = section.indexOf("### How to Flag a Matched Task");
    expect(howToFlagIdx).toBeGreaterThan(-1);
    const howToFlagSection = section.slice(howToFlagIdx);
    expect(howToFlagSection).toContain("Type A");
    expect(howToFlagSection).toContain("hitl: true");
  });

  it("keeps the existing Keyword Heuristics and Judgment Step subsections as Type A's detection mechanism", () => {
    const section = extractStep5_5Section(content);
    expect(section).toContain("### Keyword Heuristics");
    expect(section).toContain("### Judgment Step");
    const keywordIdx = section.indexOf("### Keyword Heuristics");
    const judgmentIdx = section.indexOf("### Judgment Step");
    expect(judgmentIdx).toBeGreaterThan(keywordIdx);
  });

  it("removes all Type B / requiresHumanApproval / Approval-marker language from Step 5.5", () => {
    const section = extractStep5_5Section(content);
    expect(section).not.toContain("Type B");
    expect(section).not.toContain("requiresHumanApproval");
    expect(section).not.toContain("⚠ Approval");
  });
});

describe("plan-session.md — Step 5.5 flags .claude/** write tasks as HITL (CDH-1.1)", () => {
  function extractJudgmentStepSubsection(section: string): string {
    const idx = section.indexOf("### Judgment Step");
    expect(idx).toBeGreaterThan(-1);
    const howToFlagIdx = section.indexOf("### How to Flag a Matched Task");
    expect(howToFlagIdx).toBeGreaterThan(idx);
    return section.slice(idx, howToFlagIdx);
  }

  /**
   * Extracts just the new `.claude/**` Judgment Step bullet, so assertions about its
   * wording can't be satisfied by unrelated prose elsewhere in the subsection.
   */
  function extractClaudeDirBullet(section: string): string {
    const judgmentSection = extractJudgmentStepSubsection(section);
    const idx = judgmentSection.indexOf("- Creating or modifying a file under `.claude/**`");
    expect(idx).toBeGreaterThan(-1);
    const rest = judgmentSection.slice(idx);
    // The bullet is a single markdown list item: it ends at the next blank line.
    const endIdx = rest.indexOf("\n\n");
    return endIdx === -1 ? rest : rest.slice(0, endIdx);
  }

  function extractKeywordHeuristicsCodeBlock(section: string): string {
    const idx = section.indexOf("### Keyword Heuristics");
    expect(idx).toBeGreaterThan(-1);
    const sub = section.slice(idx);
    const match = sub.match(/```[\s\S]*?```/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("Judgment Step flags a task requiring a .claude/** change as Type A HITL", () => {
    const section = extractStep5_5Section(content);
    const judgmentSection = extractJudgmentStepSubsection(section);
    expect(judgmentSection).toContain(".claude/**");
  });

  it("the .claude/** bullet itself explains writes are blocked unconditionally by the Claude Code CLI's own protection, not by any Shipwright tool-permission setting", () => {
    const section = extractStep5_5Section(content);
    const bullet = extractClaudeDirBullet(section);
    const lower = bullet.toLowerCase();
    expect(lower).toContain("blocked unconditionally");
    expect(lower).toContain("claude code cli");
    expect(lower).toContain("not blocked by any tool-permission configuration");
  });

  it("Keyword Heuristics fenced keyword list includes a .claude/ path pattern", () => {
    const section = extractStep5_5Section(content);
    const codeBlock = extractKeywordHeuristicsCodeBlock(section);
    expect(codeBlock).toContain(".claude/");
  });

  it("How to Flag a Matched Task includes a .claude/**-specific example description injection", () => {
    const section = extractStep5_5Section(content);
    const howToFlagIdx = section.indexOf("### How to Flag a Matched Task");
    expect(howToFlagIdx).toBeGreaterThan(-1);
    const howToFlagSection = section.slice(howToFlagIdx);
    expect(howToFlagSection).toContain(".claude/**");
    expect(howToFlagSection.toLowerCase()).toContain("## human steps");
  });
});

describe("plan-session.md — task table legend no longer references Approval / requiresHumanApproval (RHA-1.2)", () => {
  it("the HITL column legend documents ⚠ HITL for Type A only, not ⚠ Approval", () => {
    const hitlLegendMatch = content.match(/\*\*HITL\*\*:[\s\S]*?see Step 5\.5[\s\S]*?omit otherwise/);
    expect(hitlLegendMatch).not.toBeNull();
    const legend = hitlLegendMatch?.[0] ?? "";
    expect(legend).toContain("⚠ HITL");
    expect(legend).toContain("Type A");
    expect(legend).not.toContain("⚠ Approval");
    expect(legend).not.toContain("Type B");
  });
});

describe("plan-session.md — Step 6b template omits requiresHumanApproval (RHA-1.2)", () => {
  it("the JSON task template code block includes hitl but not requiresHumanApproval", () => {
    const section = extractStep6bSection(content);
    const codeBlockMatch = section.match(/```json[\s\S]*?```/);
    expect(codeBlockMatch).not.toBeNull();
    const codeBlock = codeBlockMatch?.[0] ?? "";
    expect(codeBlock).toContain('"hitl": false');
    expect(codeBlock).not.toContain("requiresHumanApproval");
  });

  it("prose still instructs setting hitl:true for Type A tasks, with no requiresHumanApproval / Type B instruction", () => {
    const section = extractStep6bSection(content);
    expect(section).toContain('Set `"hitl": true`');
    expect(section).toContain("Step 5.5");
    expect(section).not.toContain("requiresHumanApproval");
    expect(section).not.toContain("Type B");
  });
});

describe("plan-session.md — repo auto-detect preserves org/repo format (PRF-1.1)", () => {
  function extractArgsAndAutoDetectSection(md: string): string {
    const match = md.match(/^---[\s\S]*?Wait for user confirmation before continuing to Step 1\./);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("the repo arg description example is org/repo format, not a bare repo name", () => {
    const section = extractArgsAndAutoDetectSection(content);
    const argDescMatch = section.match(/- name: repo\n\s*description: (.+)/);
    expect(argDescMatch).not.toBeNull();
    const argDesc = argDescMatch?.[1] ?? "";
    expect(argDesc).toMatch(/e\.g\.,\s*[\w.-]+\/[\w.-]+/);
    expect(argDesc).not.toMatch(/e\.g\.,\s*shipwright\)/);
  });

  it("does not instruct stripping to the bare repo name in auto-detect", () => {
    const section = extractArgsAndAutoDetectSection(content);
    expect(section.toLowerCase()).not.toContain("bare repo name");
  });

  it("documents preserving the full owner/repo value from git remote parsing", () => {
    const section = extractArgsAndAutoDetectSection(content);
    const lower = section.toLowerCase();
    expect(lower).toMatch(/preserve|do not strip|full owner\/repo/);
  });

  it("derives a repo-slug value for local path use", () => {
    const section = extractArgsAndAutoDetectSection(content);
    expect(section).toContain("repo-slug");
  });

  it("uses {repo-slug} for local filesystem paths, not {repo}", () => {
    const section = extractArgsAndAutoDetectSection(content);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted plan-session doc text, not JS interpolation
    expect(section).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}");
    expect(section).not.toContain("~/src/{repo}/");
  });

  it("Step 1's CLAUDE.md fallback read path uses {repo-slug}", () => {
    expect(content).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted plan-session doc text, not JS interpolation
      "otherwise read from `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}/`",
    );
  });

  it("Step 6b task JSON template still writes the full org/repo value into repo", () => {
    const section = extractStep6bSection(content);
    const codeBlockMatch = section.match(/```json[\s\S]*?```/);
    expect(codeBlockMatch).not.toBeNull();
    const codeBlock = codeBlockMatch?.[0] ?? "";
    expect(codeBlock).toContain('"repo": "{repo}"');
  });
});

describe("plan-session.md — Step 4 `--autonomous` mode (PDR-3.1)", () => {
  function extractStep4Section(md: string): string {
    const match = md.match(/## Step 4: Propose a Design[\s\S]*?(?=\n## Step 5: Task Breakdown)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  function extractAutonomousSubsection(section: string): string {
    const idx = section.indexOf("### `--autonomous` Mode");
    expect(idx).toBeGreaterThan(-1);
    return section.slice(idx);
  }

  it("adds a distinct `--autonomous` Mode subsection to Step 4", () => {
    const section = extractStep4Section(content);
    expect(section).toContain("### `--autonomous` Mode");
  });

  it("states autonomous mode replaces iterate-until-approved with accept-first-pass", () => {
    const autoSection = extractAutonomousSubsection(extractStep4Section(content));
    const lower = autoSection.toLowerCase();
    expect(lower).toMatch(/accept.first.pass/);
    expect(lower).toContain("iterate-until-approved");
    expect(lower).toContain("trusted");
  });

  it("defines the loose ambiguity bar with Soft ambiguity and Hard contradiction cases", () => {
    const autoSection = extractAutonomousSubsection(extractStep4Section(content));
    expect(autoSection).toContain("Soft ambiguity");
    expect(autoSection).toContain("Hard contradiction");
    expect(autoSection).toContain("sensible default");
  });

  it("soft ambiguity applies the default and logs it instead of stalling or asking", () => {
    const autoSection = extractAutonomousSubsection(extractStep4Section(content));
    const softIdx = autoSection.indexOf("Soft ambiguity");
    const hardIdx = autoSection.indexOf("Hard contradiction");
    const softSection = autoSection.slice(softIdx, hardIdx);
    const lower = softSection.toLowerCase();
    expect(lower).toContain("apply the default");
    expect(lower).toMatch(/do not stall|not.*ask a clarifying question/);
    expect(lower).not.toContain("blockedreason");
    expect(lower).not.toContain("patch");
  });

  it("hard contradiction escapes via PATCH to blocked with hitl:true and blockedReason, then stops before Step 5", () => {
    const autoSection = extractAutonomousSubsection(extractStep4Section(content));
    expect(autoSection).toContain('"status": "blocked"');
    expect(autoSection).toContain('"hitl": true');
    expect(autoSection).toContain("blockedReason");
    expect(autoSection).toContain("plan_session_autonomous_hard_contradiction");
    expect(autoSection.toLowerCase()).toContain("do not proceed to step 5");
    expect(autoSection.toLowerCase()).toMatch(/do not fabricate|not fabricate an answer/);
  });

  it("records every accepted default in a Decision Log that carries through to PLAN.md", () => {
    const autoSection = extractAutonomousSubsection(extractStep4Section(content));
    expect(autoSection).toContain("## Decision Log");
    expect(autoSection.toLowerCase()).toContain("plan.md");
  });
});

describe("plan-session.md — Step 5 `--autonomous` mode (PDR-3.1)", () => {
  function extractStep5FullSection(md: string): string {
    const match = md.match(/## Step 5: Task Breakdown[\s\S]*?(?=\n## Step 5\.5: HITL Detection)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  function extractAutonomousSubsection(section: string): string {
    const idx = section.indexOf("### `--autonomous` Mode");
    expect(idx).toBeGreaterThan(-1);
    return section.slice(idx);
  }

  it("adds a distinct `--autonomous` Mode subsection to Step 5", () => {
    const section = extractStep5FullSection(content);
    expect(section).toContain("### `--autonomous` Mode");
  });

  it("applies the same loose ambiguity bar to breakdown-level decisions", () => {
    const autoSection = extractAutonomousSubsection(extractStep5FullSection(content));
    expect(autoSection).toContain("Soft ambiguity");
    expect(autoSection).toContain("Hard contradiction");
    expect(autoSection).toContain("sensible default");
  });

  it("hard contradiction escapes via the same PATCH-to-blocked pattern, stopping before Step 5.5", () => {
    const autoSection = extractAutonomousSubsection(extractStep5FullSection(content));
    expect(autoSection).toContain('"status": "blocked"');
    expect(autoSection).toContain('"hitl": true');
    expect(autoSection).toContain("blockedReason");
    expect(autoSection.toLowerCase()).toContain("do not proceed to step 5.5");
  });

  it("skips the iterate-until-approved loop and proceeds directly to Step 5.5", () => {
    const autoSection = extractAutonomousSubsection(extractStep5FullSection(content));
    expect(autoSection.toLowerCase()).toContain("skip");
    expect(autoSection).toContain("Step 5.5");
  });

  it("soft ambiguity defaults append to the same Decision Log started in Step 4", () => {
    const autoSection = extractAutonomousSubsection(extractStep5FullSection(content));
    expect(autoSection).toContain("Decision Log");
    expect(autoSection.toLowerCase()).toContain("step 4");
  });
});

describe("plan-session.md — `--autonomous {task-id}` argument parsing (PDR-3.1)", () => {
  function extractArgsAndAutoDetectSection(md: string): string {
    const match = md.match(/^---[\s\S]*?Wait for user confirmation before continuing to Step 1\./);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("documents the --autonomous {task-id} optional token alongside repo/session", () => {
    const section = extractArgsAndAutoDetectSection(content);
    expect(section).toContain("--autonomous");
    expect(section).toContain("{task-id}");
    // TKD-1.3: `kind: "prd"` is the only spelling now that the legacy
    // autonomousPlanSession boolean has been dropped.
    expect(section).toContain('kind: "prd"');
    expect(section.toLowerCase()).not.toContain("autonomousplansession");
  });

  it("states repo/session are always passed explicitly and the auto-detect confirmation flow does not apply", () => {
    const section = extractArgsAndAutoDetectSection(content);
    const autonomousIdx = section.indexOf("--autonomous");
    expect(autonomousIdx).toBeGreaterThan(-1);
    const autonomousSection = section.slice(autonomousIdx);
    const lower = autonomousSection.toLowerCase();
    expect(lower).toContain("does not apply");
    expect(lower).toContain("explicitly");
  });
});

describe("plan-session.md — Step 1 `--autonomous` spec materialization from the task record", () => {
  function extractStep1Section(md: string): string {
    const match = md.match(/## Step 1: Load Context[\s\S]*?(?=\n## Step 2: Explore the Codebase)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  function extractAutonomousSubsection(md: string): string {
    const section = extractStep1Section(md);
    const idx = section.indexOf("### `--autonomous` Mode");
    expect(idx).toBeGreaterThan(-1);
    return section.slice(idx);
  }

  it("adds a distinct `--autonomous` Mode subsection to Step 1", () => {
    expect(extractStep1Section(content)).toContain("### `--autonomous` Mode");
  });

  it("fetches the originating task and writes its description to planning/{session}/PRODUCT-SPEC.md when the file is absent", () => {
    const sub = extractAutonomousSubsection(content);
    expect(sub).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}");
    expect(sub).toContain("planning/{session}/PRODUCT-SPEC.md");
    expect(sub.toLowerCase()).toContain("description");
    expect(sub.toLowerCase()).toMatch(/does not exist|is absent|not found/);
  });

  it("strips the submit-prd instruction preamble before writing the spec", () => {
    const sub = extractAutonomousSubsection(content);
    expect(sub).toContain("Commit as PRODUCT-SPEC.md and run /shipwright:plan-session.");
    expect(sub.toLowerCase()).toMatch(/strip|remove|drop/);
  });

  it("blocks the task with hitl:true and a plan_session_autonomous_no_spec reason when no spec can be found", () => {
    const sub = extractAutonomousSubsection(content);
    expect(sub).toContain("plan_session_autonomous_no_spec");
    expect(sub).toContain('"status": "blocked"');
    expect(sub).toContain('"hitl": true');
    expect(sub).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}");
  });

  it("forbids the interactive 'What are we building?' fallback under --autonomous", () => {
    const sub = extractAutonomousSubsection(content);
    expect(sub).toContain("What are we building?");
    expect(sub.toLowerCase()).toMatch(/never|must not|do not/);
  });

  it("excludes the originating task from the same-session duplicate scan via a jq filter in item 3 itself, not trailing prose", () => {
    const section = extractStep1Section(content);
    const item3Idx = section.indexOf("3. Check for any existing tasks in this session");
    const item4Idx = section.indexOf("4. Scan for open tasks from prior sessions");
    expect(item3Idx).toBeGreaterThan(-1);
    expect(item4Idx).toBeGreaterThan(item3Idx);
    const item3 = section.slice(item3Idx, item4Idx);
    expect(item3).toContain("AUTONOMOUS_TASK_ID");
    expect(item3).toContain("select(.id != $t)");
    expect(item3).toContain("--autonomous");
    expect(item3.toLowerCase()).toContain("duplicate");

    const sub = extractAutonomousSubsection(content);
    expect(sub).toContain("{task-id}");
    expect(sub).toContain("select(.id != $t)");
  });
});

describe("plan-session.md — Step 6c autonomous close-out (PDR-3.1)", () => {
  it("Step 6b section includes a Step 6c gated on --autonomous that PATCHes status:done and source to PLAN.md", () => {
    const section = extractStep6bSection(content);
    expect(section).toContain("Step 6c");
    expect(section).toContain("--autonomous");
    expect(section).toContain('\\"status\\": \\"done\\"');
    expect(section).toContain('\\"source\\"');
    expect(section.toLowerCase()).toContain("plan.md");
  });

  it("only runs Step 6c after the bulk write succeeds", () => {
    const section = extractStep6bSection(content);
    const idx = section.indexOf("Step 6c");
    expect(idx).toBeGreaterThan(-1);
    const step6cSection = section.slice(idx);
    expect(step6cSection.toLowerCase()).toMatch(/only run this after|once step 6b.*succeeds/);
    expect(step6cSection.toLowerCase()).toContain("must not mark the originating task done");
  });
});

describe("plan-session.md — Step 6d persists the plan to the repo", () => {
  function step6d(): string {
    const section = extractStep6bSection(content);
    const idx = section.indexOf("Step 6d");
    expect(idx).toBeGreaterThan(-1);
    return section.slice(idx, section.indexOf("\n---", idx));
  }

  it("force-adds only the session's planning files, since planning/ is commonly gitignored", () => {
    const section = step6d();
    expect(section).toContain('add -f "planning/$SESSION/PLAN.md"');
    expect(section).toContain("never -A");
  });

  it("commits from a throwaway worktree on a docs/plan-{session} branch and opens a PR", () => {
    const section = step6d();
    expect(section).toContain('BRANCH="docs/plan-$SESSION"');
    expect(section).toContain("worktree add");
    expect(section).toContain("worktree remove");
    expect(section).toContain("gh pr create --head");
  });

  it("is idempotent — an existing PR for the branch counts as done", () => {
    const section = step6d();
    expect(section).toContain("--state all");
    expect(section.toLowerCase()).toContain("do not open a second one");
  });

  it("never blocks the plan and surfaces the PR in the confirmation", () => {
    const section = step6d();
    expect(section.toLowerCase()).toContain("never blocks the plan");
    expect(section.toLowerCase()).toContain("must never fail on this step");
    expect(content).toContain("Plan PR: {url}");
  });

  it("guards the jq existing-PR lookup against an empty array printing the literal string 'null'", () => {
    const section = step6d();
    // `.[0].url` on `[]` raw-outputs the literal text "null" (a non-empty string
    // that would otherwise satisfy `grep -q .`) — `// empty` must be present on
    // every `.[0].url` lookup so the branch only matches a genuine URL.
    const jqLookups = section.match(/-q '\.\[0\]\.url[^']*'/g) ?? [];
    expect(jqLookups.length).toBeGreaterThan(0);
    for (const lookup of jqLookups) {
      expect(lookup).toContain("// empty");
    }
  });

  it("resets (not errors on) a pre-existing local branch ref before adding the worktree", () => {
    const section = step6d();
    // A prior run can push the branch and then fail before `gh pr create` — the
    // branch ref survives `worktree remove --force`. `-B` resets/creates instead
    // of `-b`, which would fail outright with "branch already exists" on retry.
    expect(section).toContain('worktree add -q -B "$BRANCH"');
    expect(section).not.toMatch(/worktree add -q -b "\$BRANCH"/);
  });

  it("runs a mechanical secret-pattern scan on the staged diff before committing", () => {
    const section = step6d();
    expect(section).toContain("SECRET_PATTERN");
    expect(section).toContain("PRIVATE KEY");
    // The scan must gate the commit itself, not just live as prose.
    const scanIdx = section.indexOf("SECRET_PATTERN");
    const commitIdx = section.indexOf("git -C \"$WT\" commit");
    expect(scanIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(scanIdx);
    // SECRET_PATTERN begins with a literal '-', so without the `--` argument
    // separator grep parses it as option flags and errors out on every
    // invocation, making the gate a permanent no-op. The `--` forces grep to
    // treat the rest of the args as the pattern.
    expect(section).toContain('grep -qE -- "$SECRET_PATTERN"');
  });
});

describe("plan-session.md — Step 6d opens the plan PR with the shipwright label (POF-2.3)", () => {
  function step6d(): string {
    const section = extractStep6bSection(content);
    const idx = section.indexOf("Step 6d");
    expect(idx).toBeGreaterThan(-1);
    return section.slice(idx, section.indexOf("\n---", idx));
  }

  it("includes a gh label create shipwright line with --force flag before the gh pr create invocation", () => {
    const section = step6d();
    expect(section).toContain("gh label create shipwright");
    expect(section).toContain("--force");
    const labelCreateIdx = section.indexOf("gh label create shipwright");
    // "gh pr create" (without --head) is a false landmark here: an earlier
    // comment in this same section ("...failed after push but before `gh pr
    // create`...") mentions the phrase before the real invocation.
    const prCreateIdx = section.indexOf("gh pr create --head");
    expect(labelCreateIdx).toBeGreaterThan(-1);
    expect(prCreateIdx).toBeGreaterThan(-1);
    expect(labelCreateIdx).toBeLessThan(prCreateIdx);
  });

  it("includes --label shipwright in the gh pr create invocation", () => {
    const section = step6d();
    expect(section).toContain("--label shipwright");
  });

  it("includes the shipwright label description and color in the label-create command", () => {
    const section = step6d();
    expect(section).toContain("Opened autonomously by Shipwright");
    expect(section).toContain("1D76DB");
  });

  it("documents that --force makes the label-create step idempotent", () => {
    const section = step6d();
    expect(section.toLowerCase()).toContain("idempotent");
    expect(section.toLowerCase()).toContain("--force");
  });
});

describe("plan-session.md — Step 5 principles override check + security domain (PCO-1.1)", () => {
  function extractStep5Section(md: string): string {
    const match = md.match(/## Step 5: Task Breakdown[\s\S]*?(?=\n### Complexity and Model Scoring)/);
    expect(match).not.toBeNull();
    return match?.[0] ?? "";
  }

  it("Step 5 preamble checks .claude/shipwright/principles.md before falling back", () => {
    const section = extractStep5Section(content);
    expect(section).toContain(".claude/shipwright/principles.md");
  });

  it("Step 5 preamble mentions fallback to references/principles.md", () => {
    const section = extractStep5Section(content);
    expect(section).toContain("references/principles.md");
  });

  it("Step 5 preamble describes checking/loading project override before falling back", () => {
    const section = extractStep5Section(content);
    const lower = section.toLowerCase();
    expect(lower).toMatch(/check.*project|project.*override|override.*check/);
  });

  it("Step 5 preamble cites security as one of the domains alongside architecture and testing", () => {
    const section = extractStep5Section(content);
    expect(section).toContain("security");
    expect(section).toContain("architecture");
    expect(section).toContain("testing");
  });
});

/**
 * Phase-methodology dispatch (PSM-1.2).
 *
 * Steps 2 through 5.5 (codebase research → design → task breakdown → HITL detection) become
 * swappable via `phaseMethodology["plan-session"]`, per PSM-1.1's contract
 * (`references/methodology-contracts/plan-session.md`). With no config, the built-in steps run
 * exactly as before; with config set, the decomposition is delegated to the configured
 * subagent and its `tasks[]` output must clear a client-side schema gate before the Step 6b
 * bulk POST ever runs.
 */

function extractPlanSessionSubagentSection(md: string): string {
  const idx = md.indexOf("### Resolve the configured plan-session subagent (PSM-1.2)");
  const step2Idx = md.indexOf("## Step 2: Explore the Codebase");
  expect(idx).toBeGreaterThan(-1);
  expect(step2Idx).toBeGreaterThan(idx);
  return md.slice(idx, step2Idx);
}

function extractMethodologyDispatchSection(md: string): string {
  const idx = md.indexOf("## Configured Methodology Dispatch (PSM-1.2)");
  const step6Idx = md.indexOf("## Step 6: Write to Queue");
  expect(idx).toBeGreaterThan(-1);
  expect(step6Idx).toBeGreaterThan(idx);
  return md.slice(idx, step6Idx);
}

function extractDispatchSubsection(md: string, heading: string): string {
  const section = extractMethodologyDispatchSection(md);
  const idx = section.indexOf(heading);
  expect(idx).toBeGreaterThan(-1);
  const rest = section.slice(idx + heading.length);
  const nextIdx = rest.indexOf("\n#### ");
  return heading + (nextIdx === -1 ? rest : rest.slice(0, nextIdx));
}

/**
 * Collapses markdown line-wrapping to single spaces (and lowercases), so a prose assertion
 * asserts on the sentence rather than on where the paragraph happens to wrap.
 */
function prose(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

/**
 * Extracts just the `### Inputs` subsection of the dispatch section, so input assertions
 * can't be satisfied by unrelated prose elsewhere (the section discusses `repo`/`session`
 * throughout, which makes a whole-section `toContain("repo")` near-zero signal).
 */
function extractInputsSubsection(md: string): string {
  const section = extractMethodologyDispatchSection(md);
  const idx = section.indexOf("### Inputs");
  const dispatchIdx = section.indexOf("### Dispatch");
  expect(idx).toBeGreaterThan(-1);
  expect(dispatchIdx).toBeGreaterThan(idx);
  return section.slice(idx, dispatchIdx);
}

/**
 * Extracts the single `### Inputs` bullet for one contract field, so each field's
 * load-bearing wording (notably its omission rule) is asserted against its own bullet
 * rather than against the whole subsection.
 */
function extractInputBullet(md: string, field: string): string {
  const inputs = extractInputsSubsection(md);
  const marker = `- **\`${field}\`**`;
  const idx = inputs.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const rest = inputs.slice(idx);
  // Each input is one markdown list item: it ends at the next top-level bullet or blank line.
  const nextBullet = rest.indexOf("\n- **");
  return nextBullet === -1 ? rest : rest.slice(0, nextBullet);
}

describe("plan-session.md — Step 1 resolves the configured plan-session subagent (PSM-1.2)", () => {
  it("adds the resolution subsection inside Step 1, before Step 2", () => {
    const step1Idx = content.indexOf("## Step 1: Load Context");
    const sectionIdx = content.indexOf("### Resolve the configured plan-session subagent (PSM-1.2)");
    const step2Idx = content.indexOf("## Step 2: Explore the Codebase");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(step1Idx);
    expect(step2Idx).toBeGreaterThan(sectionIdx);
  });

  it("fetches phaseMethodology['plan-session'] from GET /agents/{id}/config, same endpoint/auth as review.md and patch.md", () => {
    const section = extractPlanSessionSubagentSection(content);
    expect(section).toContain('curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY"');
    expect(section).toContain("$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config");
    expect(section).toContain('.phaseMethodology["plan-session"]');
    expect(section).toContain("PLAN_SESSION_SUBAGENT_TYPE=$(curl");
  });

  it("resolves to empty when the field is absent, null, or the lookup fails", () => {
    const section = extractPlanSessionSubagentSection(content);
    expect(section).toContain("// empty");
    const lower = section.toLowerCase();
    expect(lower).toMatch(/fail-soft|best-effort/);
    expect(lower).toContain("never a hard stop");
  });

  it("states that an empty/failed lookup leaves the built-in Steps 2 through 5.5 unchanged (AC1)", () => {
    const section = extractPlanSessionSubagentSection(content);
    expect(section).toContain("Steps 2 through 5.5");
    const lower = section.toLowerCase();
    expect(lower).toMatch(/unchanged|exactly as (they do )?today|identical to today/);
    expect(lower).toContain("not fail-open");
  });

  it("documents that there is no built-in subagent_type fallback name, because the built-in decomposition is not dispatchable", () => {
    const section = extractPlanSessionSubagentSection(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("no built-in `subagent_type` fallback name");
    expect(lower).toContain("not itself a dispatchable subagent");
    expect(lower).toContain("inline");
  });

  it("instructs skipping Steps 2 through 5.5 and jumping to the Configured Methodology Dispatch section when set", () => {
    const section = extractPlanSessionSubagentSection(content);
    const lower = section.toLowerCase();
    expect(lower).toContain("skip steps 2 through 5.5");
    expect(section).toContain("Configured Methodology Dispatch (PSM-1.2)");
    expect(section).toContain("Step 6");
  });
});

describe("plan-session.md — Configured Methodology Dispatch section (PSM-1.2)", () => {
  it("sits between Step 5.5 and Step 6", () => {
    const step5_5Idx = content.indexOf("## Step 5.5: HITL Detection");
    const sectionIdx = content.indexOf("## Configured Methodology Dispatch (PSM-1.2)");
    const step6Idx = content.indexOf("## Step 6: Write to Queue");
    expect(step5_5Idx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(step5_5Idx);
    expect(step6Idx).toBeGreaterThan(sectionIdx);
  });

  it("only runs when PLAN_SESSION_SUBAGENT_TYPE resolved non-empty; otherwise proceed straight to Step 6", () => {
    const section = extractMethodologyDispatchSection(content);
    expect(section).toContain("PLAN_SESSION_SUBAGENT_TYPE");
    const lower = section.toLowerCase();
    expect(lower).toMatch(/non-empty/);
    expect(lower).toMatch(/skip this (entire )?section|proceed (straight|directly) to step 6/);
  });

  it("gives the ### Inputs subsection a bullet for every contract input and no extra ones", () => {
    const inputs = extractInputsSubsection(content);
    const declared = [...inputs.matchAll(/^- \*\*`([^`]+)`\*\*/gm)].map((m) => m[1]);
    expect(declared).toEqual([
      "specContent",
      "repo",
      "session",
      "existingSessionTaskIds",
      "openCrossSessionTasks",
      "testLayerDefs",
      "principles",
      "autonomous",
    ]);
  });

  it("loads testLayerDefs and principles explicitly, since their built-in load sites (Steps 2 and 5) are skipped", () => {
    const testLayerDefs = extractInputBullet(content, "testLayerDefs");
    expect(testLayerDefs).toContain("docs/test-readiness/test-system.md");
    expect(testLayerDefs).toContain("Step 2");
    const principles = extractInputBullet(content, "principles");
    expect(principles).toContain(".claude/shipwright/principles.md");
    expect(principles).toContain("plugins/shipwright/references/principles.md");
    expect(principles).toContain("Step 5");
  });

  /**
   * The contract's omission rules are load-bearing: passing an empty array (or a present-but-
   * empty field) instead of omitting it is a contract violation the field-name-presence
   * assertions above cannot catch. Each rule is asserted against its own input bullet.
   */
  it("states the contract's omission rule on each optional input's own bullet", () => {
    expect(extractInputBullet(content, "existingSessionTaskIds").toLowerCase()).toMatch(
      /omit when empty|omit.*\bempty\b/,
    );
    expect(extractInputBullet(content, "openCrossSessionTasks").toLowerCase()).toMatch(
      /omit entirely when none/,
    );
    expect(extractInputBullet(content, "testLayerDefs").toLowerCase()).toMatch(
      /omit the field when the file is absent/,
    );
    expect(extractInputBullet(content, "autonomous").toLowerCase()).toMatch(
      /omit the field entirely otherwise/,
    );
  });

  /**
   * `specContent` is a required contract input with no omission rule, but Step 1 explicitly
   * allows an interactive session with no PRODUCT-SPEC.md ("What are we building?"). Without a
   * rule for that path a human running this command against a configured methodology in a
   * spec-less repo would dispatch with `specContent` undefined.
   */
  it("says what specContent carries on Step 1's interactive no-spec-file path", () => {
    const specContent = extractInputBullet(content, "specContent");
    const lower = prose(specContent);
    expect(lower).toContain("what are we building?");
    expect(lower).toMatch(/required/);
    expect(lower).toMatch(/never (omitted|dispatched with `?speccontent`? missing)/);
    expect(lower).toMatch(/pass the description collected|passed as `?speccontent/);
  });

  it("requires exactly the contract's inputs — no more, no less — and passes autonomous as {taskId}", () => {
    const inputs = extractInputsSubsection(content);
    expect(inputs).toContain(
      "plugins/shipwright/references/methodology-contracts/plan-session.md",
    );
    expect(inputs.toLowerCase()).toContain("no more, no less");
    expect(extractInputBullet(content, "autonomous")).toContain('{taskId: "{task-id}"}');
  });

  it("dispatches via the Agent tool with subagent_type: PLAN_SESSION_SUBAGENT_TYPE and run_in_background: false (AC2)", () => {
    const section = extractMethodologyDispatchSection(content);
    expect(section).toContain("Agent tool");
    expect(section).toContain("subagent_type: PLAN_SESSION_SUBAGENT_TYPE");
    expect(section).toContain("run_in_background: false");
  });

  it("points the dispatched subagent at the PSM-1.1 contract file and expects its exact output shape", () => {
    const section = extractMethodologyDispatchSection(content);
    expect(section).toContain("plugins/shipwright/references/methodology-contracts/plan-session.md");
    for (const field of ["tasks", "planMarkdown", "decisionLog", "hardContradiction"]) {
      expect(section).toContain(field);
    }
  });
});

describe("plan-session.md — Configured Methodology Dispatch: malformed or failed response (PSM-1.2)", () => {
  const HEADING = "#### Malformed or Failed Response";

  it("retries once on malformed JSON or an outright dispatch failure", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = sub.toLowerCase();
    expect(lower).toContain("retry once");
    expect(lower).toMatch(/dispatch itself|dispatch failure/);
    expect(lower).toMatch(/invalid|nonexistent/);
  });

  it("abandons after the retry — no built-in fallback, and never claims to fall back to the built-in steps", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = sub.toLowerCase();
    expect(lower).toContain("no built-in fallback");
    expect(lower).toContain("abandon");
    expect(lower).toContain("not itself a dispatchable subagent");
    expect(lower).not.toMatch(/fall back to (running |the )?steps 2/);
    expect(lower).not.toMatch(/fall back to an inline/);
  });

  it("under --autonomous, PATCHes the task to blocked/hitl with a plan_session_methodology_dispatch_failed reason and stops before Step 6", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("--autonomous");
    expect(sub).toContain("plan_session_methodology_dispatch_failed");
    expect(sub).toContain('"status": "blocked"');
    expect(sub).toContain('"hitl": true');
    expect(sub).toContain("$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}");
    expect(sub.toLowerCase()).toContain("stop before step 6");
  });

  it("interactively, prints a clear abort message and writes no tasks", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = sub.toLowerCase();
    expect(lower).toContain("interactive");
    expect(lower).toMatch(/abort/);
    expect(lower).toContain("no tasks");
  });
});

describe("plan-session.md — Configured Methodology Dispatch: hard contradiction (PSM-1.2)", () => {
  const HEADING = "#### Hard Contradiction";

  it("mirrors Step 4/5's existing plan_session_autonomous_hard_contradiction escape hatch under --autonomous", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("plan_session_autonomous_hard_contradiction");
    expect(sub).toContain('"status": "blocked"');
    expect(sub).toContain('"hitl": true');
    expect(sub).toContain("blockedReason");
    expect(sub.toLowerCase()).toContain("stop before step 6");
  });

  it("treats a non-null hardContradiction outside --autonomous as a contract violation and stops", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = sub.toLowerCase();
    expect(lower).toContain("contract");
    expect(lower).toMatch(/violat/);
    expect(sub).toContain("hardContradiction");
    expect(lower).toMatch(/always `?null`? outside|null outside `?--autonomous/);
    expect(lower).toMatch(/no human-iteration loop|there is no human/);
  });
});

describe("plan-session.md — Configured Methodology Dispatch: schema validation gate (PSM-1.2, AC3)", () => {
  const HEADING = "#### Schema Validation";

  it("runs before Step 6 / before the bulk POST", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = sub.toLowerCase();
    expect(lower).toMatch(/before .*step 6/);
    expect(lower).toMatch(/before .*(bulk )?post|before ever posting/);
  });

  it("checks id format, non-empty branch, and dependency-id resolvability", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("{PREFIX}-{N}.{M}");
    expect(sub).toContain("branch");
    expect(sub.toLowerCase()).toContain("non-empty string");
    expect(sub).toContain("dependencies");
    expect(sub).toContain("existingSessionTaskIds");
    expect(sub).toContain("openCrossSessionTasks");
    expect(sub.toLowerCase()).toMatch(/this batch|same batch/);
  });

  it("checks non-empty title, status pending, and acceptanceCriteria as an array", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("title");
    expect(sub).toContain('"pending"');
    expect(sub).toContain("acceptanceCriteria");
    expect(sub.toLowerCase()).toContain("array");
  });

  /**
   * The PSM-1.1 contract specifies `repo` as "the `repo` passed in, unchanged" — a value
   * contract, not key-presence. `validateRepo` in task-store/src/routes/tasks.ts returns early
   * on a literal `null`, so a `null` repo is written through and leaves the task undispatchable
   * (dev-task derives its worktree paths from `task.repo`), while a wrong/hallucinated
   * `org/repo` 400s the whole batch after Step 6a already wrote PLAN.md.
   */
  it("value-checks repo against the repo input rather than merely asserting key presence", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const repoIdx = sub.indexOf("**`repo`**");
    expect(repoIdx).toBeGreaterThan(-1);
    const check = prose(sub.slice(repoIdx));
    expect(check).toMatch(/equals the `?repo`? value passed in as an input, exactly/);
    expect(check).toMatch(/value contract, not just key-presence/);
    expect(check).toMatch(/key-presence alone is not enough/);
    expect(check).toMatch(/`?"?repo"?: null`?/);
    expect(check).toMatch(/undispatchable/);
    expect(check).toMatch(/validaterepo/);
    // Mirrors check 11's session value-equality standard.
    expect(check).toMatch(/check 11/);
  });

  it("rejects the WHOLE batch on any failing task — all-or-nothing, do not POST anything", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = sub.toLowerCase();
    expect(lower).toContain("all-or-nothing");
    expect(lower).toMatch(/whole batch/);
    expect(lower).toMatch(/do not post/);
    expect(lower).toMatch(/per-task|which check/);
  });

  it("under --autonomous, blocks with a plan_session_methodology_schema_invalid reason; interactively prints and stops", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("plan_session_methodology_schema_invalid");
    expect(sub).toContain('"status": "blocked"');
    expect(sub).toContain('"hitl": true');
    const lower = sub.toLowerCase();
    expect(lower).toContain("interactive");
    expect(lower).toMatch(/never proceed to step 6/);
  });

  /**
   * `/tasks/bulk` is create-only: TaskService.bulk() translates Prisma's P2002 into a
   * ConflictError that rolls the whole batch back server-side. That 409 would land *after*
   * Step 6a has written PLAN.md, and the dispatch section defines no recovery path for it —
   * so a collision against already-queued ids has to be caught by this client-side gate.
   */
  it("checks returned ids don't collide with existingSessionTaskIds, openCrossSessionTasks, or each other", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = prose(sub);
    expect(lower).toMatch(/collid/);
    expect(lower).toMatch(/create-only|p2002|409/);
    const collisionIdx = sub.indexOf("collides with nothing");
    expect(collisionIdx).toBeGreaterThan(-1);
    const check = sub.slice(collisionIdx);
    expect(check).toContain("existingSessionTaskIds");
    expect(check).toContain("openCrossSessionTasks");
    expect(prose(check)).toMatch(/no two tasks|share an `?id/);
  });

  it("value-checks the contract-constrained model, layer, and session fields the task store stores as free-form strings", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    for (const tier of ["haiku", "sonnet", "opus"]) {
      expect(sub).toContain(tier);
    }
    for (const layer of [
      "API",
      "Frontend",
      "Database",
      "Shared",
      "Background",
      "CLI",
    ]) {
      expect(sub).toContain(layer);
    }
    const lower = prose(sub);
    expect(lower).toMatch(/free-form string/);
    expect(lower).toMatch(/rollup|sessions view|alert sweeper/);
  });

  /**
   * `planMarkdown` is a top-level contract output Step 6a writes verbatim, and it is never
   * POSTed — so no server-side check exists for it. A response with a clean `tasks[]` and an
   * empty `planMarkdown` would otherwise pass this gate and write an empty PLAN.md under
   * `--autonomous`, where no human sees it.
   */
  it("checks the top-level planMarkdown is present and non-empty, distinct from the per-task checks", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("planMarkdown");
    const lower = prose(sub);
    expect(lower).toMatch(/top-level/);
    expect(lower).toMatch(/not per-task|per-task/);
    expect(lower).toMatch(/\*\*`planmarkdown`\*\* is present and a non-empty string/);
    expect(lower).toMatch(/empty (or missing )?`?planmarkdown/);
    expect(lower).toMatch(/--autonomous/);
  });

  /**
   * The contract permits "zero or more task objects", but every per-task check passes vacuously
   * over `[]` and nothing server-side rejects an empty batch either — `/tasks/bulk` only
   * requires a JSON array and `TaskService.bulk()` gates on the upper MAX_BULK_TASKS cap, so
   * `[]` returns 200 {inserted: 0}. Step 6c would read that as success and mark the originating
   * PRD task done, which under --autonomous no human is there to notice.
   */
  it("checks the top-level tasks[] is present and non-empty, as a second top-level check", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = prose(sub);
    expect(lower).toMatch(/two \*\*top-level\*\* checks/);
    expect(lower).toMatch(
      /\*\*`tasks`\*\* is present, an array, and \*\*non-empty\*\*/,
    );
    expect(lower).toMatch(/zero or more task objects/);
    expect(lower).toMatch(/vacuous/);
    expect(lower).toMatch(/nothing server-side rejects it|nothing server-side rejects an empty/);
    expect(lower).toMatch(/--autonomous/);
  });

  it("explains that an empty tasks[] would let Step 6c mark the originating PRD task done", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = prose(sub);
    expect(lower).toMatch(/step 6c/);
    expect(lower).toMatch(/`?done`?/);
    expect(lower).toMatch(/zero work got queued/);
    expect(lower).toMatch(/max_bulk_tasks/);
    expect(lower).toMatch(/200 \{inserted: 0\}/);
    // A methodology with genuinely nothing to decompose has a handled path already.
    expect(lower).toMatch(/hardcontradiction/);
  });

  it("rejects the whole response — including PLAN.md — when either top-level check fails", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = prose(sub);
    expect(lower).toMatch(/top-level or per-task/);
    expect(lower).toMatch(/do not write `?plan\.md/);
    expect(sub).toContain("planMarkdown — failed:");
    expect(sub).toContain("tasks — failed:");
  });

  /**
   * `hitl` is exactly as contract-constrained as model/layer/session, and Step 6b now writes it
   * through with no re-detection — so a Type-A task returned with `hitl: false` would land in
   * ready.ts's autonomous-ready set (it only excludes `task.hitl === true`) and be dispatched to
   * dev-task with no human in the loop.
   */
  it("value-checks hitl as a boolean and requires a `## Human steps` section when it is true", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("`hitl`");
    expect(sub).toContain("## Human steps");
    expect(sub).toContain("task-store/src/ready.ts");
    const lower = prose(sub);
    expect(lower).toMatch(/present and a boolean/);
    expect(lower).toMatch(/`hitl: true`/);
    expect(lower).toMatch(/omitted or wrongly `?false/);
    expect(lower).toMatch(/does not re-run step 5\.5/);
  });

  it("explains why checks 8-12 — and the top-level planMarkdown check — can't be delegated to the bulk endpoint", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = prose(sub);
    expect(lower).toMatch(/never fail\s+server-side|does not enum-check|cannot catch them for you/);
    expect(lower).toMatch(/checks 8 through 12/);
    expect(lower).toMatch(/`?planmarkdown`? is never posted/);
  });

  it("on full validation success, hands tasks/planMarkdown/decisionLog to Step 6 exactly as the built-in path would", () => {
    const section = extractMethodologyDispatchSection(content);
    const idx = section.indexOf("#### Schema Validation");
    const tail = section.slice(idx);
    expect(tail).toContain("Step 6");
    expect(tail).toContain("planMarkdown");
    expect(tail).toContain("decisionLog");
  });
});

/**
 * The dispatch replaces Steps 2 through 5.5, which is where BOTH of the built-in path's
 * interactive approval gates live (Step 4's "do not move to task breakdown until the design is
 * approved" and Step 5's "iterate until approved"). Step 6 still opens on an approved
 * breakdown, so without a gate re-established on the dispatch path an interactive run against
 * a configured methodology would POST tasks and open a plan PR without the human ever seeing
 * the breakdown.
 */
describe("plan-session.md — Configured Methodology Dispatch: interactive approval gate (PSM-1.2)", () => {
  const HEADING = "#### Interactive Approval";

  it("has an Interactive Approval subsection, placed after the schema gate so invalid output is never presented for approval", () => {
    const section = extractMethodologyDispatchSection(content);
    const schemaIdx = section.indexOf("#### Schema Validation");
    const approvalIdx = section.indexOf(HEADING);
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(schemaIdx);
  });

  it("names the built-in approval gates the dispatch replaced", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("Step 4");
    expect(sub).toContain("Step 5");
    expect(prose(sub)).toContain("iterate until approved");
  });

  it("interactively, blocks Step 6 on explicit human approval of the returned breakdown", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    const lower = prose(sub);
    expect(lower).toContain("interactive");
    expect(lower).toMatch(/do not proceed to step 6 on the first response/);
    expect(lower).toMatch(/ask for approval explicitly/);
    expect(lower).toMatch(/until (the human )?approve/);
    expect(lower).toMatch(/nothing is written to disk and nothing is posted/);
  });

  it("explains why the caller owns the iterate-with-the-human loop rather than the subagent", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("run_in_background: false");
    const lower = prose(sub);
    expect(lower).toMatch(/no channel back to the user/);
  });

  it("re-dispatches with the human's feedback and re-validates, without consuming the malformed-response retry budget", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("PLAN_SESSION_SUBAGENT_TYPE");
    const lower = prose(sub);
    expect(lower).toMatch(/re-?dispatch/);
    expect(lower).toMatch(/re-?run schema validation/);
    expect(lower).toMatch(/not a retry|does not consume .*retry budget/);
  });

  it("under --autonomous there is no gate, matching Step 4/5's accept-first-pass", () => {
    const sub = extractDispatchSubsection(content, HEADING);
    expect(sub).toContain("--autonomous");
    expect(prose(sub)).toContain("accept-first-pass");
    expect(prose(sub)).toMatch(/no approval gate/);
  });
});

describe("plan-session.md — Step 6 is path-agnostic (PSM-1.2)", () => {
  function extractStep6Preamble(md: string): string {
    const idx = md.indexOf("## Step 6: Write to Queue");
    const bundleIdx = md.indexOf("### Bundle Model Inheritance (Pre-Write)");
    expect(idx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(idx);
    return md.slice(idx, bundleIdx);
  }

  function extractStep6aSection(md: string): string {
    const idx = md.indexOf("**Step 6a — Save the plan to disk:**");
    const bIdx = md.indexOf("**Step 6b — Write tasks to the store:**");
    expect(idx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(idx);
    return md.slice(idx, bIdx);
  }

  it("notes Step 6 runs identically whether the breakdown came from the built-in steps or the configured dispatch", () => {
    const preamble = extractStep6Preamble(content);
    expect(preamble).toContain("Steps 2 through 5.5");
    expect(preamble).toContain("Configured Methodology Dispatch");
    expect(preamble.toLowerCase()).toMatch(/identical|unchanged|either way/);
  });

  it("states the breakdown reaching Step 6 is already approved on every path, satisfying its own precondition", () => {
    const preamble = extractStep6Preamble(content);
    const lower = prose(preamble);
    expect(lower).toContain("already approved");
    expect(lower).toContain("interactive approval");
    expect(lower).toContain("accept-first-pass");
  });

  /**
   * The "path-agnostic" claim can't be prose-only: Step 6a's and Step 6b's own bodies
   * referenced Steps 4-5 / Step 5.5, both skipped on the dispatch path.
   */
  it("tells the reader to read Steps 4-5 / Step 5.5 references as whichever path produced the breakdown", () => {
    const preamble = extractStep6Preamble(content);
    expect(preamble).toContain("Steps 4-5");
    expect(preamble).toContain("Step 5.5");
    expect(prose(preamble)).toContain("whichever path produced this breakdown");
    expect(prose(preamble)).toMatch(/rather than re-deriving/);
  });

  it("Step 6a writes the plan markdown verbatim and forbids re-synthesizing it from the task list", () => {
    const step6a = extractStep6aSection(content);
    expect(step6a).toContain("verbatim");
    expect(step6a).toContain("planMarkdown");
    expect(prose(step6a)).toContain("do not re-synthesize");
    expect(step6a).toContain("Steps 4–5");
    expect(step6a).toContain("Configured Methodology Dispatch");
  });

  it("Step 6b's hitl instruction is source-neutral — the dispatch path's flags are written through, not re-detected", () => {
    const section = extractStep6bSection(content);
    expect(section).toContain('Set `"hitl": true`');
    expect(section).toContain("Step 5.5");
    expect(section).toContain("Configured Methodology Dispatch");
    const lower = prose(section);
    expect(lower).toMatch(/writes the flag through as received/);
    expect(lower).toMatch(/does not re-run step 5\.5/);
  });

  /**
   * Writing `hitl` through unvalidated is only safe because the dispatch section's Schema
   * Validation gate already checked it — Step 6b should say so, so a future edit that drops the
   * gate check doesn't leave this write-through silently unguarded.
   */
  it("Step 6b points at the Schema Validation gate as what makes the hitl write-through safe", () => {
    const section = extractStep6bSection(content);
    expect(section).toContain("Schema Validation");
    expect(section).toContain("## Human steps");
    expect(prose(section)).toMatch(/check 12/);
  });

  /**
   * Per the contract the Decision Log is already embedded inside `planMarkdown`, so Step 6
   * has no separate consumer for `decisionLog[]` — saying it "writes" the array invites a
   * duplicated Decision Log section in PLAN.md.
   */
  it("clarifies decisionLog[] is already inside planMarkdown, so Step 6 must not append a second Decision Log", () => {
    const section = extractMethodologyDispatchSection(content);
    const idx = section.indexOf("#### Interactive Approval");
    expect(idx).toBeGreaterThan(-1);
    const closing = section.slice(idx);
    expect(closing).toContain("decisionLog");
    expect(closing).toContain("## Decision Log");
    const lower = prose(closing);
    expect(lower).toMatch(/already embedded inside/);
    expect(lower).toMatch(/do not append a second decision log/);
    expect(lower).toContain("verbatim");
  });
});

/**
 * No-target guard (PDR-4.1).
 *
 * `docs/agent-ops.md` and `site/src/content/docs/cron-jobs.mdx` both promise that a
 * standalone pipeline cron (one whose parent `shipwright-loop` is disabled) is *silently
 * inert*: its stored prompt carries no target, so the dispatched command goes `[silent]`
 * and does nothing. The `shipwright-plan` cron's stored prompt is a bare
 * `/shipwright:plan-session` with no arguments, so that invariant only holds if
 * plan-session.md has an explicit no-argument `[silent]` guard — matching the four
 * pre-existing pipeline commands. Without it, a zero-argument invocation falls through to
 * the single-argument auto-detect path (`git remote get-url origin`, warning, wait for
 * confirmation) instead of going inert.
 */

/** Matches the imperative empty-`$ARGUMENTS` guard, e.g. "If `$ARGUMENTS` is empty, respond `[silent]` and stop". */
const EMPTY_ARGUMENTS_GUARD =
  /If `\$ARGUMENTS` is empty,[^\n]*`\[silent\]`[^\n]*stop/i;

/**
 * Matches a no-argument bullet/heading that resolves to `[silent]` on the same line, e.g.
 *   `- _(no arguments)_: respond \`[silent]\` and stop immediately`
 *   `**No arguments**: respond \`[silent]\` and stop immediately`
 *   `- _(no arguments)_: not supported — respond \`[silent]\` and stop`
 */
const NO_ARGUMENT_SILENT_CASE = /\bno arguments?\b[^\n]*`\[silent\]`/i;

/** The four pre-existing loop-driven pipeline commands plan-session must stay consistent with. */
const SIBLING_PIPELINE_COMMANDS = [
  "dev-task",
  "review",
  "patch",
  "deploy",
] as const;

describe("plan-session.md — no-argument [silent] guard (PDR-4.1)", () => {
  it("documents a no-arguments case that goes [silent]", () => {
    expect(content).toMatch(NO_ARGUMENT_SILENT_CASE);
  });

  it("has an explicit empty-$ARGUMENTS [silent] guard", () => {
    expect(content).toMatch(EMPTY_ARGUMENTS_GUARD);
  });

  it("places the guard before the single-argument auto-detect-and-confirm flow", () => {
    const guardIndex = content.search(EMPTY_ARGUMENTS_GUARD);
    const autoDetectIndex = content.indexOf(
      "**If only one argument is provided**",
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(autoDetectIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(autoDetectIndex);
  });

  it("keeps the single-argument auto-detect-and-confirm flow intact for human invocation", () => {
    expect(content).toContain("**If only one argument is provided**");
    expect(content).toContain("git remote get-url origin");
    expect(content).toContain(
      "Wait for user confirmation before continuing to Step 1.",
    );
  });

  for (const command of SIBLING_PIPELINE_COMMANDS) {
    it(`stays consistent with ${command}.md, which also goes [silent] with no target`, () => {
      const siblingContent = readFileSync(
        join(import.meta.dir, `${command}.md`),
        "utf-8",
      );
      expect(siblingContent).toMatch(NO_ARGUMENT_SILENT_CASE);
    });
  }
});
