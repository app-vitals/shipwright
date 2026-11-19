import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRD_MD_PATH = join(import.meta.dir, "prd.md");

let content: string;

beforeAll(() => {
  content = readFileSync(PRD_MD_PATH, "utf-8");
});

function extractPhase0ResolutionSection(md: string): string {
  const sectionIdx = md.indexOf(
    "### Resolve the configured prd subagent (PRM-1.2)",
  );
  const step2Idx = md.indexOf("2. **Detect toolchain**");
  expect(sectionIdx).toBeGreaterThan(-1);
  expect(step2Idx).toBeGreaterThan(sectionIdx);
  return md.slice(sectionIdx, step2Idx);
}

function extractDispatchSection(md: string): string {
  const sectionIdx = md.indexOf("## Configured Methodology Dispatch (PRM-1.2)");
  const phase5Idx = md.indexOf("## Phase 5: Summary and Next Steps");
  expect(sectionIdx).toBeGreaterThan(-1);
  expect(phase5Idx).toBeGreaterThan(sectionIdx);
  return md.slice(sectionIdx, phase5Idx);
}

describe("prd.md — Phase 0 resolves the configured prd-phase subagent (PRM-1.2)", () => {
  it("places the resolution subsection after step 1 (folder creation) and before step 2 (toolchain detection)", () => {
    const step1Idx = content.indexOf("1. **Create the planning folder**");
    const resolveIdx = content.indexOf(
      "### Resolve the configured prd subagent (PRM-1.2)",
    );
    const step2Idx = content.indexOf("2. **Detect toolchain**");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(step1Idx);
    expect(step2Idx).toBeGreaterThan(resolveIdx);
  });

  it("fetches phaseMethodology.prd from GET /agents/{id}/config, same endpoint/auth as review.md, patch.md, and plan-session.md's own phase resolutions", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain(
      'curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY"',
    );
    expect(section).toContain(
      "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config",
    );
    expect(section).toContain(".phaseMethodology.prd");
  });

  it("PRD_SUBAGENT_TYPE defaults to empty (not a fabricated built-in name) when phaseMethodology.prd is absent or null", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain("PRD_SUBAGENT_TYPE=$(curl");
    expect(section).toContain(".phaseMethodology.prd // empty");
  });

  it("documents there is no built-in subagent_type fallback name for prd, unlike review.md's shipwright:code-reviewer", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain("no built-in `subagent_type` fallback name");
    expect(section.toLowerCase()).toContain(
      "not itself a dispatchable subagent",
    );
  });

  it("documents this lookup as fail-soft/best-effort, never a hard stop", () => {
    const section = extractPhase0ResolutionSection(content);
    const lower = section.toLowerCase();
    expect(lower).toMatch(/fail-soft/);
    expect(lower).toContain("never a hard stop");
  });

  it("states that an empty PRD_SUBAGENT_TYPE means step 2 through Phase 4 run unchanged (today's behavior)", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section.toLowerCase()).toContain("run unchanged");
    expect(section.toLowerCase()).toContain("exactly as they do today");
  });

  it("states that a non-empty PRD_SUBAGENT_TYPE still runs step 2b (repo detection) before jumping to the dispatch section", () => {
    const section = extractPhase0ResolutionSection(content);
    expect(section).toContain("step 2b");
    expect(section).toContain("Configured Methodology Dispatch (PRM-1.2)");
  });
});

describe("prd.md — no config set behaves identically to today (acceptance criterion 1)", () => {
  it("keeps the full, unmodified Phase 1 through Phase 4 built-in flow present verbatim", () => {
    expect(content).toContain("## Phase 1: Interactive Discovery");
    expect(content).toContain("## Phase 2: Research Enrichment");
    expect(content).toContain(
      "## Phase 2b: Complexity Review (PO Decision Gate)",
    );
    expect(content).toContain("## Phase 3: Draft the spec");
    expect(content).toContain("## Phase 4: User Review and Finalize");
    expect(content).toContain(
      "### Q1 — Session Name (skip if $ARGUMENTS is already descriptive)",
    );
    expect(content).toContain("### Q9 — Success Criteria");
  });

  it("keeps Phase 0's toolchain detection, doc reading, and research steps unchanged", () => {
    expect(content).toContain(
      "2. **Detect toolchain** by scanning the project root in this order:",
    );
    expect(content).toContain("3. **Read project documentation**");
    expect(content).toContain("4. **Research existing context**");
  });
});

describe("prd.md — Configured Methodology Dispatch section (PRM-1.2)", () => {
  it("is placed after Phase 4 and before Phase 5", () => {
    const phase4Idx = content.indexOf("## Phase 4: User Review and Finalize");
    const dispatchIdx = content.indexOf(
      "## Configured Methodology Dispatch (PRM-1.2)",
    );
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    expect(phase4Idx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(phase4Idx);
    expect(phase5Idx).toBeGreaterThan(dispatchIdx);
  });

  it("is skipped entirely when PRD_SUBAGENT_TYPE is empty", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain(
      "Skip this entire section when `PRD_SUBAGENT_TYPE` is empty",
    );
  });

  it("documents the contract-defined inputs: session folder name and live human interaction, no pre-assembled payload", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("references/methodology-contracts/prd.md");
    expect(section).toContain("PRM-1.1");
    expect(section).toContain("$ARGUMENTS");
    expect(section.toLowerCase()).toContain("no pre-assembled");
  });

  it("dispatches via the Agent tool with subagent_type: PRD_SUBAGENT_TYPE and run_in_background: false", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("subagent_type: PRD_SUBAGENT_TYPE");
    expect(section).toContain("run_in_background: false");
  });

  it("points the dispatched subagent at the contract and the product-spec template", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("references/methodology-contracts/prd.md");
    expect(section).toContain("references/product-spec-template.md");
  });

  it("instructs the subagent to write output at the resolved {SPEC_PATH} (numbered, legacy-aware)", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("`{SPEC_PATH}`");
    expect(section).toContain("`specPath`, `specNumber`, `repos`, `owner`");
  });

  it("states this command does not relay questions/answers -- the subagent conducts its own live turn-by-turn session", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toContain("does not relay questions");
  });
});

describe("prd.md — Structural Validation of the dispatched subagent's output (PRM-1.2)", () => {
  it("checks the file exists and is non-empty", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("### Structural Validation");
    expect(section.toLowerCase()).toContain("exists and is non-empty");
  });

  it("checks for every required top-level section heading from the contract", () => {
    const section = extractDispatchSection(content);
    for (const heading of [
      "Overview",
      "Problem Statement",
      "Users & Context",
      "Features",
      "Technical Constraints",
      "Scope",
      "Priorities & Sequence",
      "Testing Strategy",
      "Resolved Decisions",
      "Success Criteria",
    ]) {
      expect(section).toContain(heading);
    }
  });

  it("checks for no unresolved TBD markers, per the contract's quality bar", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("TBD");
  });

  it("checks every feature section has at least one checkbox acceptance criterion", () => {
    const section = extractDispatchSection(content);
    expect(section).toMatch(
      /Every `### Feature` section contains at least one checkbox acceptance criterion/,
    );
    expect(section).toContain("`- [ ]`");
  });

  it("clarifies structural validation is not a re-grading of content quality/probing depth", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toContain(
      "not a re-grading of content quality",
    );
  });
});

describe("prd.md — Malformed or Failed Response handling falls back to the built-in flow (PRM-1.2)", () => {
  it("retries once with the same PRD_SUBAGENT_TYPE and the same prompt on dispatch failure or Structural Validation failure", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("### Malformed or Failed Response (PRM-1.2)");
    expect(section).toContain("retry once with the same `PRD_SUBAGENT_TYPE`");
  });

  it("falls back to running the built-in flow inline when the retry also fails, not to abandoning the session", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toMatch(
      /fall back to\s+running the built-in flow inline/,
    );
  });

  it("contrasts this with plan-session.md's PSM-1.2, which abandons instead of falling back", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("plan-session.md");
    expect(section).toContain("PSM-1.2");
    expect(section.toLowerCase()).toContain("abandons");
  });

  it("prints a one-line note when the fallback fires", () => {
    const section = extractDispatchSection(content);
    expect(section).toContain("falling back to the");
    expect(section).toContain("built-in PRD flow");
  });

  it("states Phase 5 always runs against a real, structurally valid spec regardless of which path produced it", () => {
    const section = extractDispatchSection(content);
    expect(section.toLowerCase()).toMatch(
      /phase 5 always\s+runs against a real, structurally valid spec/,
    );
  });
});

describe("prd.md — Phase 5 is path-agnostic (PRM-1.2)", () => {
  it("notes Phase 5 runs identically whether the built-in flow or the configured dispatch produced the spec", () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const printIdx = content.indexOf("Print:", phase5Idx);
    expect(phase5Idx).toBeGreaterThan(-1);
    expect(printIdx).toBeGreaterThan(phase5Idx);
    const section = content.slice(phase5Idx, printIdx);
    expect(section).toContain("PRM-1.2");
    expect(section.toLowerCase()).toContain("path-agnostic");
  });

  it("instructs deriving the summary counts from the written PRODUCT-SPEC.md on the dispatch path, since no in-session tally exists there", () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const printIdx = content.indexOf("Print:", phase5Idx);
    const section = content.slice(phase5Idx, printIdx);
    expect(section.toLowerCase()).toContain(
      "no such tally exists in this thread",
    );
    expect(section).toContain("derive every count directly from the written");
  });

  it("carves out the two figures that cannot be reconstructed from the artifact: Complexity Flags is omitted and Resolved Decisions drops its Q8/Phase-2b split", () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const printIdx = content.indexOf("Print:", phase5Idx);
    const section = content.slice(phase5Idx, printIdx);
    expect(section).toContain(
      "Omit the `Complexity Flags:` line entirely when",
    );
    expect(section).toMatch(
      /Print just\s+`Resolved Decisions: \{N decisions recorded\}` on the dispatch path/,
    );
    expect(section).toContain("`(N driven from Q8, N from Phase 2b)` split is not");
  });
});

describe("prd.md — Phase 3 acceptance criteria require automated verification", () => {
  it("requires at least one criterion per feature that maps to automated verification", () => {
    const phase3Idx = content.indexOf("## Phase 3: Draft the spec");
    const phase4Idx = content.indexOf("## Phase 4: User Review and Finalize");
    expect(phase3Idx).toBeGreaterThan(-1);
    expect(phase4Idx).toBeGreaterThan(phase3Idx);
    const section = content.slice(phase3Idx, phase4Idx);
    expect(section).toContain(
      "At least one criterion per feature must map to automated verification",
    );
  });
});

describe("prd.md — --initiative close-out (ICO-1.2)", () => {
  const extractCloseout = () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const start = content.indexOf("**Initiative close-out**", phase5Idx);
    expect(phase5Idx).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(phase5Idx);
    const end = content.indexOf("## Important Notes", start);
    expect(end).toBeGreaterThan(start);
    return content.slice(start, end);
  };

  it("documents --initiative {task-id} and folder-name parsing before Phase 0", () => {
    const head = content.slice(0, content.indexOf("## Phase 0"));
    expect(head).toContain("`--initiative {task-id}`");
    expect(head).toMatch(/first token is the session/);
    expect(head).toContain("`--repos a,b`");
    expect(head).toContain("`--owner email`");
    expect(head).toContain("name: --initiative");
  });

  it("places the close-out inside Phase 5, after the heading", () => {
    const phase5Idx = content.indexOf("## Phase 5: Summary and Next Steps");
    const specWriteIdx = content.indexOf("4. Write the approved spec to");
    expect(specWriteIdx).toBeGreaterThan(-1);
    expect(specWriteIdx).toBeLessThan(phase5Idx);
    expect(extractCloseout().length).toBeGreaterThan(0);
  });

  it("checks kind is initiative or idea", () => {
    const s = extractCloseout();
    expect(s).toContain("GET");
    expect(s).toMatch(/`initiative`/);
    expect(s).toMatch(/`idea`/);
  });

  it("skips tasks that are already closed", () => {
    const s = extractCloseout();
    for (const st of ["done", "merged", "deployed", "released", "cancelled"]) {
      expect(s).toContain(st);
    }
  });

  it("PATCHes to done with source pointing at the spec path and sets specDocumentId", () => {
    const s = extractCloseout();
    expect(s).toContain("PATCH");
    expect(s).toContain("{SPEC_PATH}");
    expect(s).toContain("specDocumentId");
    expect(s).toMatch(/\\"status\\": \\"done\\"/);
  });

  it("warns and continues on wrong kind, already closed, 404, or failed PATCH — never fails the session", () => {
    const s = extractCloseout();
    expect(s).toMatch(/warning/i);
    expect(s).toContain("404");
    expect(s).toMatch(/never fails the session/i);
  });

  it("states both built-in and Configured Methodology Dispatch paths reach it", () => {
    const s = extractCloseout();
    expect(s).toContain("path-agnostic");
    expect(s).toContain("Configured Methodology Dispatch");
    expect(s).toMatch(/built-in/);
  });
});

describe("prd.md — numbered specs, repos, owner (PLU-3.2)", () => {
  const step2c = () =>
    content.slice(
      content.indexOf("2c. **Resolve session documents"),
      content.indexOf("3. **Read project documentation**"),
    );

  it("documents the form with --repos, --owner and --initiative", () => {
    expect(content).toContain(
      "/shipwright:prd {session} [--repos a,b] [--owner email] [--initiative id]",
    );
  });

  it("specifies the next-number rule including the legacy PRODUCT-SPEC.md case", () => {
    const s = step2c();
    expect(s).toContain("`SPEC-{NNNN}.md`");
    expect(s).toMatch(/`PRODUCT-SPEC\.md` counts as spec 1/);
    expect(s).toContain("keeps its name");
    expect(s).toContain("`SPEC-0002.md`");
    expect(s).toMatch(/never rename or overwrite the legacy file/);
  });

  it("writes spec 1 as PRODUCT-SPEC.md until plan-session reads numbered specs", () => {
    const s = step2c();
    expect(s).toContain("**Interim spec-1 filename (until PLU-4.2).**");
    expect(s).toMatch(
      /spec 1 of a session that has no specs yet is written as `PRODUCT-SPEC\.md`/,
    );
    expect(s).toContain("Specs 2 and up use `SPEC-{NNNN}.md`");
  });

  it("specifies the read order for existing content: open docs branch, default branch, local", () => {
    const s = step2c();
    const a = s.indexOf("open docs branch");
    const b = s.indexOf("default branch", a);
    const c = s.indexOf("local checkout", b);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("specifies lazy registration through the PLU-3.1 module before numbering", () => {
    const s = step2c();
    expect(s).toContain("**Lazy registration.**");
    expect(s).toContain("scripts/register-planning-documents.ts");
    expect(s).toContain("zero document rows");
    expect(s).toContain("before numbering");
  });

  it("stops and says where the documents live when the home repo differs", () => {
    const s = step2c();
    expect(s).toContain("**stop**");
    expect(s).toContain("already lives in {home repo}");
  });

  it("defaults owner to git config user.email, with --owner and initiative owner overriding, and never writes it to a file", () => {
    const s = step2c();
    expect(s).toContain("git config user.email");
    expect(s).toContain("`--owner`");
    expect(s).toMatch(/Never write the owner/);
    expect(s).toContain("Owner: {owner}");
  });

  it("warns once and continues when the store lacks document endpoints", () => {
    const s = step2c();
    expect(s).toContain("Warn once");
    expect(s).toContain("DOCS_API=off");
    expect(s).toContain("today's behaviour");
  });

  it("starts each new file with a header line without the owner", () => {
    expect(content).toContain(
      "<!-- shipwright: session={session} repos={repos} spec={NNNN} -->",
    );
    expect(content).toMatch(/never the owner/);
  });

  it("registers the document, opens the docs PR, and records prUrl and state", () => {
    expect(content).toContain("4a. **Register the document**");
    expect(content).toContain("/documents");
    expect(content).toContain("4c. **Record the PR**");
    expect(content).toContain('"state": "pr_open"');
  });

  it("keeps git add -f on the specific file, never edits .gitignore, and keeps the scrub gate", () => {
    expect(content).toContain('git -C "$WT" add -f "planning/$SESSION/$SPEC_FILE"');
    expect(content).toMatch(/never edit the repo's `\.gitignore`/);
    expect(content).toContain("SECRET_PATTERN=");
  });

  it("hands off with the two-argument form plan-session accepts today", () => {
    expect(content).toContain("NEXT: /plan-session {repo} $ARGUMENTS");
    expect(content).not.toMatch(/^NEXT: \/plan-session \$ARGUMENTS$/m);
    expect(content).toContain("The handoff line must contain two arguments");
  });

  it("warns that plan-session does not read SPEC-NNNN.md specs yet", () => {
    expect(content).toContain(
      "⚠ plan-session does not read SPEC-{NNNN}.md files yet (PLU-4.2)",
    );
  });
});

describe("prd.md — concise one-section-at-a-time chat interaction (CSM-2.2)", () => {
  it("defines chat message rules: ask last, max 3 bullets, ~10-line cap", () => {
    const idx = content.indexOf("## Chat Message Rules (CSM-2.2)");
    const phase0Idx = content.indexOf("## Phase 0: Project Context Setup");
    expect(idx).toBeGreaterThan(-1);
    expect(phase0Idx).toBeGreaterThan(idx);
    const section = content.slice(idx, phase0Idx);
    expect(section).toContain("**Ask last.**");
    expect(section).toContain("**Max 3 bullets.**");
    expect(section).toContain("8-10 lines");
    expect(section).toContain("Look right? 1 yes / 2 adjust");
  });

  it("keeps one question at a time", () => {
    expect(content).toContain("**One question at a time**");
  });

  it("Phase 3 presents a bullet summary per section with the ask last, and still writes full text to the spec file", () => {
    const start = content.indexOf("## Phase 3: Draft the spec");
    const end = content.indexOf("## Phase 4: User Review and Finalize");
    const section = content.slice(start, end);
    expect(section).toContain("bullet summary (3-5 bullets");
    expect(section).toContain("with the ask **last**");
    expect(section).toContain("Look right? 1 yes / 2 adjust");
    expect(section).toContain("complete section text is still written to the spec file");
  });

  it("Phase 4 no longer pastes the full spec into chat", () => {
    const start = content.indexOf("## Phase 4: User Review and Finalize");
    const end = content.indexOf("4a. **Register the document**");
    const section = content.slice(start, end);
    expect(section).toContain("Do not paste the assembled spec into chat");
    expect(section).toContain("1 yes / 2 adjust");
  });

  it("Phase 0 summary and complexity flags are condensed to headline + bullets with the ask last", () => {
    expect(content).toContain("**Phase 0 summary (chat).** Condense to a headline plus at most 3 bullets, ask last");
    const start = content.indexOf("## Phase 2b: Complexity Review");
    const end = content.indexOf("## Phase 3: Draft the spec");
    const section = content.slice(start, end);
    expect(section).toContain("one flag per message");
    expect(section).toContain("How to handle? 1 keep as-is / 2 simplify / 3 flag for engineering");
  });

  it("Phase 5 summary is condensed to headline + bullets + links", () => {
    const start = content.indexOf("## Phase 5: Summary and Next Steps");
    const section = content.slice(start);
    expect(section).toContain("The summary is condensed — a headline, at most 3 bullets, and links");
    expect(section).toContain("PRD COMPLETE — {N} features, spec at {SPEC_PATH}");
  });

  // Retired: the previous Phase 3/4/2b/5 wording was pinned only implicitly; the
  // removed verbose text ("Does this look right, or would you like to adjust anything here?",
  // "Here's the complete Product Specification", the "What this means / Business impact"
  // flag block and the per-feature "{N} requirements, {N} acceptance criteria" lines)
  // must not return.
  it("does not contain the retired verbose summary text", () => {
    expect(content).not.toContain("Does this look right, or would you like to adjust anything here?");
    expect(content).not.toContain("Here's the complete Product Specification");
    expect(content).not.toContain("Business impact:");
    expect(content).not.toContain("{N} requirements, {N} acceptance criteria");
  });
});
