import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REVIEW_LEAN_MD_PATH = join(import.meta.dir, "review-lean.md");
const REVIEW_MD_PATH = join(import.meta.dir, "review.md");
const REFERENCES_DIR = join(import.meta.dir, "..", "references", "review-lean");
const REQUIRED_STEPS_PATH = join(
  import.meta.dir,
  "..",
  "references",
  "required-steps",
  "review.json",
);
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

interface RequiredStep {
  stepNumber: string;
  title: string;
  proofOfRunning: string;
}

let spine: string;
let refs: Record<string, string>;
let corpus: string;
let reviewMd: string;
let steps: RequiredStep[];

/** Collapse whitespace so wrapped prose compares equal across files. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** Remove all whitespace: GraphQL documents compare equal however they are wrapped. */
function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Text of one `## Step N:` / `### Step N:` section, up to the next heading (not a `# ->` code comment). */
function stepBlock(stepNumber: string): string {
  const escaped = stepNumber.replace(/\./g, "\\.");
  const heading = new RegExp(`^#{2,3} Step ${escaped}:`, "m");
  const match = heading.exec(spine);
  if (!match) return "";
  const rest = spine.slice(match.index + match[0].length);
  const end = rest.search(/^#{1,3} [A-Z]/m);
  return rest.slice(0, end === -1 ? undefined : end);
}

/** Text of a `## ` section whose heading starts with `title`, up to the next `## `. */
function section(title: string): string {
  const start = spine.indexOf(`\n## ${title}`);
  expect(start).toBeGreaterThan(-1);
  const rest = spine.slice(start + 1);
  const end = rest.slice(3).search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end + 3);
}

/** Relative markdown link targets (no URLs, no in-page anchors). */
function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1].split("#")[0])
    .filter((target) => target !== "" && !/^[a-z]+:/i.test(target));
}

function indexOfOrFail(haystack: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  expect({ needle, found: idx > -1 }).toEqual({ needle, found: true });
  return idx;
}

/**
 * Every fenced bash block (from its `bun run ...` line to the closing fence,
 * comment lines included) that invokes the given plugin script.
 */
function scriptBlocks(markdown: string, script: string): string[] {
  const blocks: string[] = [];
  for (const m of markdown.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const body = m[1];
    const marker = `bun run "\${CLAUDE_PLUGIN_ROOT}/scripts/${script}"`;
    const at = body.indexOf(marker);
    if (at !== -1) blocks.push(body.slice(at));
  }
  return blocks;
}

/** The GraphQL document passed via `-f query='...'` after `prefix`. */
function graphqlAfter(markdown: string, prefix: string): string {
  const start = markdown.indexOf(prefix);
  expect(start).toBeGreaterThan(-1);
  const open = markdown.indexOf("-f query='", start) + "-f query='".length;
  return markdown.slice(open, markdown.indexOf("'", open));
}

/** The live-review jq program (the single-quoted argument after `--arg currentUser`). */
function liveReviewJq(markdown: string): string {
  const anchor = `jq --arg currentUser "$CURRENT_USER" '`;
  const start = markdown.indexOf(anchor);
  expect(start).toBeGreaterThan(-1);
  const open = start + anchor.length;
  return markdown.slice(open, markdown.indexOf("')", open));
}

beforeAll(() => {
  spine = readFileSync(REVIEW_LEAN_MD_PATH, "utf-8");
  refs = Object.fromEntries(
    readdirSync(REFERENCES_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => [f, readFileSync(join(REFERENCES_DIR, f), "utf-8")]),
  );
  corpus = [
    spine,
    ...Object.entries(refs)
      .filter(([f]) => f !== "dropped-details.md")
      .map(([, c]) => c),
  ].join("\n\n");
  reviewMd = readFileSync(REVIEW_MD_PATH, "utf-8");
  steps = JSON.parse(readFileSync(REQUIRED_STEPS_PATH, "utf-8")).steps;
});

describe("review-lean.md — spine shape", () => {
  it("is at most 150 lines", () => {
    const lines = spine.endsWith("\n")
      ? spine.slice(0, -1).split("\n")
      : spine.split("\n");
    expect(lines.length).toBeLessThanOrEqual(150);
  });

  it("frontmatter mirrors review.md's and marks the lean variant", () => {
    const frontmatter = spine.slice(0, spine.indexOf("---", 3));
    expect(frontmatter).toMatch(/^---\ndescription: Lean review variant/);
    expect(frontmatter).toContain('argument-hint: "org/repo#number"');
  });

  it("keeps the explicit-target-only rule: no argument → [silent], no discovery", () => {
    const args = section("Arguments");
    expect(args).toContain("**required**");
    expect(args).toContain("**No arguments**: respond `[silent]` and stop");
    expect(args).toMatch(/before any GitHub or task-store query/);
    expect(args).toContain("no PR discovery");
    expect(spine).not.toContain("gh pr list");
  });

  it("names the mechanics directory and the required-steps table", () => {
    expect(spine).toContain("plugins/shipwright/references/review-lean/");
    expect(spine).toContain(
      "plugins/shipwright/references/required-steps/review.json",
    );
  });

  it("states the no-size-exemption rule for the review dispatch", () => {
    expect(norm(stepBlock("7"))).toContain(
      "Never review inline instead — no size exemption.",
    );
  });
});

describe("review-lean.md — a Proof line for every required-steps/review.json step", () => {
  // The signal each step's Proof line must name, keyed by stepNumber. Every
  // review.json step must appear here so a new required step fails this test.
  const expectedProof: Record<string, string[]> = {
    "5": ["GraphQL `reviewThreads` fetch", "5.5 review state:"],
    "6.1": ["compute-pr-risk-signals.ts", "6.1 risk signals:"],
    "7": ["Agent dispatch", "REVIEW_SUBAGENT_TYPE"],
    "9.5": ["9.5 unaddressed findings:"],
    "10.5": ["10.5 verdict validation: valid"],
    "11b": ["POST /prs/{id}/complete", "agentId", "reviewedCommitSha"],
  };

  it("covers every step in review.json", () => {
    expect(steps.map((s) => s.stepNumber).sort()).toEqual(
      Object.keys(expectedProof).sort(),
    );
  });

  it("each review.json step has its own section with a **Proof:** line", () => {
    for (const step of steps) {
      const block = stepBlock(step.stepNumber);
      expect({ step: step.stepNumber, found: block !== "" }).toEqual({
        step: step.stepNumber,
        found: true,
      });
      expect({
        step: step.stepNumber,
        proofLine: /^\*\*Proof:\*\* /m.test(block),
      }).toEqual({ step: step.stepNumber, proofLine: true });
    }
  });

  it("each Proof line names the step's signal", () => {
    for (const step of steps) {
      const block = stepBlock(step.stepNumber);
      const proof = norm(block.slice(block.indexOf("**Proof:**")));
      for (const token of expectedProof[step.stepNumber]) {
        expect({
          step: step.stepNumber,
          token,
          ok: proof.includes(token),
        }).toEqual({ step: step.stepNumber, token, ok: true });
      }
    }
  });
});

describe("review-lean.md — gate invocations are identical to review.md", () => {
  for (const script of [
    "compute-review-verdict.ts",
    "compute-unaddressed-findings.ts",
  ]) {
    it(`${script}: every review.md invocation appears verbatim in the spine, and nothing else`, () => {
      const original = scriptBlocks(reviewMd, script);
      const lean = scriptBlocks(spine, script);
      expect(original.length).toBeGreaterThan(0);
      expect(lean).toEqual(original);
    });
  }

  it("the reference files never re-invoke the gate scripts", () => {
    for (const [file, content] of Object.entries(refs)) {
      for (const script of [
        "compute-review-verdict.ts",
        "compute-unaddressed-findings.ts",
      ]) {
        expect({
          file,
          script,
          n: scriptBlocks(content, script).length,
        }).toEqual({ file, script, n: 0 });
      }
    }
  });

  it("does not restate the verdict truth table", () => {
    expect(corpus).not.toMatch(
      /\| selfReview \| unaddressedFindings \| currentPassHasBlockingFindings \|/,
    );
    expect(corpus).not.toMatch(/Case 1 — self-authored PR/);
  });

  it("assigns PRIOR_FINDINGS_STATUS_JSON from Step 7's priorFindingsStatus[] (or []) before Step 9.5 uses it", () => {
    const assign = indexOfOrFail(
      spine,
      "Assign `PRIOR_FINDINGS_STATUS_JSON` = the parsed `priorFindingsStatus[]`",
    );
    expect(norm(stepBlock("7"))).toContain("or `[]` when none was returned");
    const use = indexOfOrFail(
      spine,
      '--argjson priorFindingsStatus "$PRIOR_FINDINGS_STATUS_JSON"',
    );
    expect(assign).toBeLessThan(use);
  });

  it("Step 9.5 forces COMMENT and is never skipped because another input forces it", () => {
    const block = norm(stepBlock("9.5"));
    expect(block).toContain("Computed mechanically, never by judgment");
    expect(block).toContain("`PR_AUTHOR` as `prAuthor`");
    expect(block).toContain(
      "the verdict is `COMMENT` regardless of the subagent",
    );
    expect(block).toContain(
      "never skip this gate because another input already forces `COMMENT`",
    );
  });

  it("Step 10 keeps the literal Verdict: label rule, including the self-review case", () => {
    const block = norm(stepBlock("10"));
    expect(block).toContain("Use `event` and `verdictLabel` verbatim");
    expect(block).toContain(
      "MUST lead with the literal `Verdict: APPROVE` or `Verdict: COMMENT` matching `verdictLabel`",
    );
    expect(block).toContain("forced to `COMMENT` by self-review");
    expect(block).toContain("canonical `PR_AUTHOR == CURRENT_USER`");
    expect(block).toContain("only when `verdictLabel` is APPROVE");
  });

  it("Step 10.5 hard-aborts on valid: false", () => {
    const block = norm(stepBlock("10.5"));
    expect(block).toContain("`valid: false` → **hard abort**");
    expect(block).toContain("do not post or stage");
    expect(block).toContain("re-validate");
  });
});

describe("review-lean.md — literal code carried over from review.md", () => {
  it("the Live-Review Pre-Check GraphQL query matches review.md (whitespace-insensitive)", () => {
    expect(squash(graphqlAfter(spine, "precheck=$("))).toBe(
      squash(graphqlAfter(reviewMd, "precheck=$(")),
    );
  });

  it("the Step 5.5 review-state GraphQL query matches review.md (whitespace-insensitive)", () => {
    expect(squash(graphqlAfter(spine, "RESPONSE=$("))).toBe(
      squash(graphqlAfter(reviewMd, "RESPONSE=$(")),
    );
  });

  it("the live-review jq predicate is byte-identical to review.md's", () => {
    expect(liveReviewJq(spine)).toBe(liveReviewJq(reviewMd));
  });

  it("the claim body is the same jq object as review.md's", () => {
    const body =
      "'{claimedBy: $claimedBy, repo: $repo, prNumber: $prNumber, commitSha: $commitSha, authorLogin: $authorLogin, headRef: $headRef, title: $title}'";
    expect(reviewMd).toContain(body);
    expect(stepBlock("4")).toContain(body);
  });
});

describe("review-lean.md — kept guards (DTA-10.4 'keep in spine')", () => {
  it("Live-Review Pre-Check (RVD-1.2) runs before any claim, with its settle-and-stop", () => {
    const block = norm(stepBlock("14"));
    expect(block).toContain("Live-Review Pre-Check (RVD-1.2)");
    expect(block).toContain(
      "before any record fetch, claim or checkout, even with a pre-claim marker",
    );
    expect(block).toContain("`gh api` has no `--arg`; pipe to `jq`");
    expect(block).toContain(
      "`terminal` true → record lookup, then settle-and-stop `already-reviewed-at-head`",
    );
    expect(block).toContain("No claim, no checkout.");
    expect(block).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell placeholder in asserted prompt text, not JS interpolation
      "Skipping #{pr} — a review already exists at this commit (${headRefOid:0:7}) on GitHub (cross-task-store check), nothing to do.",
    );
  });

  it("the shared settle-and-stop block: one atomic PATCH advancing reviewedAt, tagged skip-reason, [silent]", () => {
    const block = norm(stepBlock("14"));
    expect(block).toContain("one atomic PATCH, no separate release");
    expect(block).toContain(
      `'{reviewState: "posted", reviewedCommitSha: $sha, reviewedAt: $now}'`,
    );
    expect(block).toContain("RCT-1.1");
    expect(block).toContain(
      "emit `[skip-reason:review:deferred:{reason}:{pr}]` immediately before `[silent]`",
    );
    expect(block).toContain("SKIP_BLOCK_THRESHOLD");
  });

  it("both skip-reason reasons are named at their call sites", () => {
    expect(spine).toContain("settle-and-stop `already-reviewed-at-head`");
    expect(spine).toContain("settle-and-stop `unresolved-human-feedback`");
    // review.md's two markers, interpolated from the shared block.
    expect(reviewMd).toContain(
      "[skip-reason:review:deferred:already-reviewed-at-head:{pr}]",
    );
    expect(reviewMd).toContain(
      "[skip-reason:review:deferred:unresolved-human-feedback:{pr}]",
    );
  });

  it("Pre-Claim Fast Path (CBD-1.4): marker parsed once, validated against the live head", () => {
    expect(section("Arguments")).toContain("[preclaim:{recordId}:{commitSha}]");
    const block = norm(stepBlock("14"));
    expect(block).toContain("Pre-Claim Fast Path (CBD-1.4)");
    expect(block).toContain(
      "equal to `PRECLAIM_COMMIT_SHA` → `PR_RECORD_ID = PRECLAIM_RECORD_ID`",
    );
    expect(block).toContain(
      "skip the record fetch, staged check, dedup check and the claim call",
    );
    expect(block).toContain(
      "`LAST_REVIEWED_COMMIT` stays unset, so Step 5's Unresolved Comment Check treats it as a first review",
    );
  });

  it("staged branch: current → print and stop; stale → re-claim and re-review; never posts staged", () => {
    const block = norm(stepBlock("14"));
    expect(block).toContain(
      "#{pr} already has a staged review ({verdict}) waiting on a decision.",
    );
    expect(block).toContain(
      "Run /shipwright:review-staged to post, skip, or discuss it.",
    );
    expect(block).toContain("head moved → claim");
    expect(section("Arguments")).toContain("Never posts a staged review.");
  });

  it("task-store dedup: posted/approved at the same head settles with already-reviewed-at-head", () => {
    const block = norm(stepBlock("14"));
    expect(block).toContain(
      "**Dedup**: `reviewState` `posted`/`approved` and head == `reviewedCommitSha` → settle-and-stop `already-reviewed-at-head`",
    );
  });

  it("claim: one call, 409 → [silent] and stop, skipped on the fast path", () => {
    const block = norm(stepBlock("4"));
    expect(block).toContain('"$SHIPWRIGHT_TASK_STORE_URL/prs/claim"');
    expect(block).toContain("Skipped on the fast path.");
    expect(block).toContain(
      "`409` → another agent holds the claim: `[silent]`, stop.",
    );
  });

  it("linked-task model tier: highest tier among GET /tasks?repo&pr matches, best-effort", () => {
    const block = stepBlock("4");
    expect(block).toContain("/tasks?repo={org}/{repo}&pr={pr}");
    expect(block).toContain("{opus: 3, sonnet: 2, haiku: 1}");
    expect(norm(block)).toContain("highest tier wins");
  });

  it("config: DB-first policy with select(. != null) and a fail-closed review subagent type (RVM-1.2)", () => {
    const block = stepBlock("1");
    expect(block).toContain(".autoPostReviews | select(. != null)");
    expect(block).toContain(".allowSelfReview | select(. != null)");
    expect(block).toContain(
      `.phaseMethodology.review // "shipwright:code-reviewer"`,
    );
    expect(block).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell placeholder in asserted prompt text, not JS interpolation
      "REVIEW_SUBAGENT_TYPE=${REVIEW_SUBAGENT_TYPE:-shipwright:code-reviewer}",
    );
    expect(norm(block)).toContain("`min_confidence` 75, `max_findings` 5");
    expect(block).toContain("scripts/login-identity.ts");
  });

  it("Step 5: diff against origin/$base with the file-count sanity check", () => {
    const block = norm(stepBlock("5"));
    expect(block).toContain('git diff "origin/$base"...HEAD');
    expect(block).toContain("never bare `$base`");
    expect(block).toContain("**Sanity check**");
    expect(block).toContain("never review a wrong diff");
  });

  it("Step 5: PVD-1.2 prior qualifying reviews reuse the exported helpers and full reviewRef", () => {
    const block = norm(stepBlock("5"));
    expect(block).toContain(
      "`isSelfCleanApprove`/`isSupersededBySelfReview` (reuse, never re-derive)",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell placeholder in asserted prompt text, not JS interpolation
    expect(block).toContain("`${review.commit.oid}@${review.submittedAt}`");
    expect(block).toContain("never a short SHA");
  });

  it("one ledger POST form, non-fatal, always before Step 11b's /complete", () => {
    const block = norm(stepBlock("5"));
    expect(block).toContain(
      `'{ref: $ref, disposition: $disposition, source: "review", evidence: $evidence}'`,
    );
    expect(block).toContain(
      "every one completes before Step 11b's `/complete`, never after",
    );
    expect(block).toContain("**PFL-2.1**");
  });

  it("Unresolved Comment Check (UCC-1.1): head-moved bypass, script call, settle-and-stop", () => {
    const block = norm(stepBlock("5"));
    expect(block).toContain(
      "`LAST_REVIEWED_COMMIT` set and `headRefOid != LAST_REVIEWED_COMMIT` → skip it",
    );
    expect(block).toContain("scripts/compute-unresolved-comment-check.ts");
    expect(block).toContain("never by judgment");
    expect(block).toContain(
      "Skipping #{pr} — unresolved feedback from @{login} ({type} on {date}). No commits since.",
    );
  });

  it("claim heartbeat is renewed after the Unresolved Comment Check, before the review phase", () => {
    const block = stepBlock("5");
    const ledger = indexOfOrFail(block, "PR_FINDINGS_JSON=$(");
    const ucc = indexOfOrFail(block, "**Unresolved Comment Check (UCC-1.1).**");
    const heartbeat = indexOfOrFail(block, "/prs/{PR_RECORD_ID}/heartbeat");
    expect(ledger).toBeLessThan(ucc);
    expect(ucc).toBeLessThan(heartbeat);
  });

  it("Step 5.8 dependency detection: script, three match rules, any author, reference on a match", () => {
    const block = norm(stepBlock("5.8"));
    expect(block).toContain("scripts/resolve-dependency-watched-paths.ts");
    expect(block).toContain("not gated on `PR_AUTHOR`");
    expect(block).toContain("**exact match**");
    expect(block).toContain(
      "**basename match** only when the entry is a bare filename",
    );
    expect(block).toContain(
      "**directory-prefix match** when the entry ends with `/`",
    );
    expect(block).toContain("(../references/dependency-risk-analysis.md)");
    expect(block).toContain(
      "No match → no dependency section anywhere downstream.",
    );
  });

  it("Step 6.1 risk signals are computed, non-fatally", () => {
    const block = norm(stepBlock("6.1"));
    expect(block).toContain("scripts/compute-pr-risk-signals.ts");
    expect(block).toContain('RISK_SIGNALS=""');
    expect(block).toContain("non-fatal");
  });

  it("Step 7: dispatch inputs, failure chain, risk rating", () => {
    const block = norm(stepBlock("7"));
    expect(block).toContain("`subagent_type: REVIEW_SUBAGENT_TYPE`");
    expect(block).toContain("`model: TASK_MODEL ?? 'sonnet'`");
    expect(block).toContain("`run_in_background: false`");
    expect(block).toContain("`Prior Findings — Requires Resolution Check`");
    expect(block).toContain("`acceptanceCriteria`");
    expect(block).toContain("`testReadinessContext`");
    expect(block).toContain("Failure chain (RVM-1.2)");
    expect(block).toContain(
      "At most override → retry → built-in → retry → inline; never loop.",
    );
    expect(block).toContain("scripts/compute-risk-rating.ts");
    expect(block).toContain("`resolved: true` entry → ledger POST `resolved`");
  });

  it("Step 7 multi-reviewer: comma trigger plus the four must-run rules", () => {
    const block = norm(stepBlock("7"));
    expect(block).toContain(
      "if `REVIEW_SUBAGENT_TYPE` contains a comma, Read [multi-reviewer.md](../references/review-lean/multi-reviewer.md)",
    );
    expect(block).toContain(
      "Dispatch all reviewers in one parallel Agent call",
    );
    expect(block).toContain(
      "merge their responses before any Step 8 threshold",
    );
    expect(block).toContain(
      "when more than one response survives, verify with `shipwright:finding-verifier` (non-fatal on failure)",
    );
  });

  it("Step 8 computes CURRENT_PASS_HAS_BLOCKING_FINDINGS after thresholds", () => {
    const block = norm(section("Steps 8-10.5"));
    expect(block).toContain(
      "Drop findings below `min_confidence`, trim to `max_findings`",
    );
    expect(block).toContain(
      "`CURRENT_PASS_HAS_BLOCKING_FINDINGS` = any remaining `important`/`critical` finding",
    );
  });

  it("Step 11: RHR-1.1 stale-head re-check immediately before the POST, releasing and skipping 11b", () => {
    const block = norm(stepBlock("11"));
    expect(block).toContain("**RHR-1.1**, immediately before the POST");
    expect(block).toContain(
      "currentHeadRefOid=$(gh pr view {pr} --repo {org}/{repo} --json headRefOid -q '.headRefOid')",
    );
    expect(block).toContain(
      "Aborted stale review for #{pr} -- head moved ({headRefOid[0..7]} -> {currentHeadRefOid[0..7]}) since claim; releasing for re-review.",
    );
    const recheck = indexOfOrFail(block, "**RHR-1.1**");
    const post = indexOfOrFail(
      block,
      "gh api -X POST /repos/{org}/{repo}/pulls/{pr}/reviews",
    );
    expect(recheck).toBeLessThan(post);
  });

  it("Step 11: the POST goes to a temp file and is never re-executed", () => {
    const block = norm(stepBlock("11"));
    expect(block).toContain('> "/tmp/pr_post_{pr}.json" 2>&1 || POST_EXIT=$?');
    expect(block).toContain('never `echo "$var" | jq`');
    expect(block).toContain("**Never re-execute this POST**");
  });

  it("Step 11: a failed post releases the claim and skips 11b", () => {
    const block = norm(stepBlock("11"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell placeholder in asserted prompt text, not JS interpolation
    expect(block).toContain("/prs/${PR_RECORD_ID}/release");
    expect(block).toContain(
      "Warning: review post for #{pr} failed (exit {POST_EXIT}) — released claim, will retry next pass.",
    );
  });

  it("Step 11: PFL-5.2 self-review ledger write is ordered before Step 11b", () => {
    const block = norm(stepBlock("11"));
    expect(block).toContain("**PFL-5.2**, before 11b");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell placeholder in asserted prompt text, not JS interpolation
    expect(block).toContain('`REF="${headRefOid}@${SUBMITTED_AT}"`');
    const pfl = indexOfOrFail(block, "**PFL-5.2**");
    const complete = indexOfOrFail(block, "6. Step 11b.");
    expect(pfl).toBeLessThan(complete);
  });

  it("Step 11: staged path is one PATCH that clears the claim, no 11b", () => {
    const block = norm(stepBlock("11"));
    expect(block).toContain('"staged": true');
    expect(block).toContain('"claimedBy": null');
    expect(block).toContain("Review staged for #{pr}.");
    expect(block).toContain("No 11b.");
  });

  it("Step 11b: /complete behind the record-id guard, never touching task status", () => {
    const block = norm(stepBlock("11b"));
    expect(block).toContain('[ -n "$PR_RECORD_ID" ]');
    expect(block).toContain("`POST /prs/{PR_RECORD_ID}/complete`");
    expect(block).toContain("`agentId` = `$SHIPWRIGHT_AGENT_ID`");
    expect(block).toContain("after every ledger POST");
    expect(block).toContain(
      "**Never update task status when posting a review**",
    );
  });

  it("keeps the seven retained Review Quality Rules", () => {
    const rules = norm(section("Review Quality Rules"));
    for (const rule of [
      "**Verify before flagging**",
      "**check scope**",
      "**Don't echo CI**",
      "**don't contradict CLAUDE.md**",
      "**No filler language**",
      "**Organize by file and line**",
      "**Breaking API changes**",
    ]) {
      expect(rules).toContain(rule);
    }
  });
});

describe("review-lean.md — step order is behavior", () => {
  it("sections run identity → Step 14 → 4 → 5 → 5.8 → 6 → 6.1 → 7 → 8-10.5 → 11 → 11b", () => {
    let last = -1;
    for (const h of [
      "## Arguments",
      "## Step 1:",
      "## Step 14:",
      "## Step 4:",
      "## Step 5:",
      "## Step 5.8:",
      "## Step 6:",
      "### Step 6.1:",
      "## Step 7:",
      "## Steps 8-10.5:",
      "### Step 9.5:",
      "### Step 10:",
      "### Step 10.5:",
      "## Step 11:",
      "### Step 11b:",
    ]) {
      const idx = indexOfOrFail(spine, h);
      expect({ h, ordered: idx > last }).toEqual({ h, ordered: true });
      last = idx;
    }
  });

  it("within Step 14: pre-check → terminal stop → fast path → staged → dedup", () => {
    const block = stepBlock("14");
    let last = -1;
    for (const marker of [
      "precheck=$(",
      "- `terminal` true",
      "- **Pre-Claim Fast Path (CBD-1.4)**",
      "**Staged**",
      "- **Dedup**",
    ]) {
      const idx = indexOfOrFail(block, marker);
      expect({ marker, ordered: idx > last }).toEqual({
        marker,
        ordered: true,
      });
      last = idx;
    }
  });

  it("within Step 4: claim → worktree → model tier", () => {
    const block = stepBlock("4");
    const claim = indexOfOrFail(block, "/prs/claim");
    const worktree = indexOfOrFail(block, "worktree add");
    const tier = indexOfOrFail(block, "TASK_MODEL=$(");
    expect(claim).toBeLessThan(worktree);
    expect(worktree).toBeLessThan(tier);
  });
});

describe("review-lean references — files exist and links resolve", () => {
  const expectedFiles = [
    "dropped-details.md",
    "guards-detail.md",
    "ledger-and-findings.md",
    "multi-reviewer.md",
    "review-file-template.md",
    "step7-dispatch.md",
    "verdict-folding.md",
  ];

  it("ships the audit's proposed reference files plus dropped-details.md", () => {
    expect(Object.keys(refs).sort()).toEqual(expectedFiles);
  });

  it("every relative link in the spine resolves", () => {
    const links = relativeLinks(spine);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(dirname(REVIEW_LEAN_MD_PATH), link);
      expect({ link, exists: existsSync(target) }).toEqual({
        link,
        exists: true,
      });
    }
  });

  it("the spine links every reference file", () => {
    const linked = new Set(
      relativeLinks(spine).map((l) => resolve(dirname(REVIEW_LEAN_MD_PATH), l)),
    );
    for (const f of expectedFiles) {
      expect({ f, linked: linked.has(join(REFERENCES_DIR, f)) }).toEqual({
        f,
        linked: true,
      });
    }
  });

  it("reuses the shared references unchanged by link", () => {
    for (const shared of [
      "(../references/post-review-guide.md)",
      "(../references/dependency-risk-analysis.md)",
      "(../references/methodology-contracts/review.md)",
    ]) {
      expect(spine).toContain(shared);
    }
  });

  it("every relative link inside the reference files resolves", () => {
    for (const [file, content] of Object.entries(refs)) {
      for (const link of relativeLinks(content)) {
        const target = resolve(REFERENCES_DIR, link);
        expect({ file, link, exists: existsSync(target) }).toEqual({
          file,
          link,
          exists: true,
        });
      }
    }
  });

  it("multi-reviewer.md keeps the MPS-2.2 duplicate rule and the MPS-2.3 verifier", () => {
    const multi = norm(refs["multi-reviewer.md"]);
    expect(multi).toContain("`abs(a.line - b.line) <= 3`");
    expect(multi).toContain("Jaccard overlap >= 0.6");
    expect(multi).toContain(
      "`resolved: true` only if EVERY surviving reviewer",
    );
    expect(multi).toContain(
      "finding verifier failed; using unverified merged findings",
    );
  });

  it("dropped-details.md records what was cut and why", () => {
    const dropped = refs["dropped-details.md"];
    expect(dropped).toContain("| Dropped | Reason |");
    expect(dropped).toContain("review-drop-audit.md");
    expect(dropped).toContain("PRIOR_FINDINGS_STATUS_JSON");
    expect(dropped).toMatch(/Deliberately not changed/);
  });
});

describe("review-lean — not wired to any cron or default dispatch", () => {
  it("is absent from the coding specialty defaults and the loop's PHASE_COMMANDS", () => {
    for (const rel of [
      "admin/src/coding/coding-specialty-defaults.ts",
      "agent/src/coding/loop-orchestrator.ts",
    ]) {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) continue;
      expect({
        rel,
        mentions: readFileSync(path, "utf-8").includes("review-lean"),
      }).toEqual({ rel, mentions: false });
    }
  });

  it("review.md does not reference the lean variant", () => {
    expect(reviewMd).not.toContain("review-lean");
  });
});
