import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PATCH_LEAN_MD_PATH = join(import.meta.dir, "patch-lean.md");
const PATCH_MD_PATH = join(import.meta.dir, "patch.md");
const REFERENCES_DIR = join(import.meta.dir, "..", "references", "patch-lean");
const REQUIRED_STEPS_PATH = join(
  import.meta.dir,
  "..",
  "references",
  "required-steps",
  "patch.json",
);
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

interface RequiredStep {
  stepNumber: string;
  title: string;
  proofOfRunning: string;
  lane: string;
}

let spine: string;
let refs: Record<string, string>;
let corpus: string;
let patchMd: string;
let steps: RequiredStep[];

/** Collapse whitespace so wrapped prose compares equal across files. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ");
}

/** Text of one step in the spine: a `## Step N:` heading section or a `- **N**` bullet. */
function stepBlock(stepNumber: string): string {
  const escaped = stepNumber.replace(/\./g, "\\.");
  const heading = new RegExp(`^#{2,3} Step ${escaped}:`, "m");
  const bullet = new RegExp(`^- \\*\\*${escaped}\\*\\* `, "m");
  const headingMatch = heading.exec(spine);
  if (headingMatch) {
    const rest = spine.slice(headingMatch.index + headingMatch[0].length);
    const end = rest.search(/^## /m);
    return rest.slice(0, end === -1 ? undefined : end);
  }
  const bulletMatch = bullet.exec(spine);
  if (bulletMatch) {
    const rest = spine.slice(bulletMatch.index + bulletMatch[0].length);
    const end = rest.search(/^(- \*\*|## )/m);
    return rest.slice(0, end === -1 ? undefined : end);
  }
  return "";
}

/** Relative markdown link targets (no URLs, no in-page anchors). */
function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1].split("#")[0])
    .filter((target) => target !== "" && !/^[a-z]+:/i.test(target));
}

function indexOfOrFail(haystack: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  expect(idx).toBeGreaterThan(-1);
  return idx;
}

beforeAll(() => {
  spine = readFileSync(PATCH_LEAN_MD_PATH, "utf-8");
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
  patchMd = readFileSync(PATCH_MD_PATH, "utf-8");
  steps = JSON.parse(readFileSync(REQUIRED_STEPS_PATH, "utf-8")).steps;
});

describe("patch-lean.md — spine shape", () => {
  it("is at most 150 lines", () => {
    const lines = spine.endsWith("\n")
      ? spine.slice(0, -1).split("\n")
      : spine.split("\n");
    expect(lines.length).toBeLessThanOrEqual(150);
  });

  it("frontmatter has a description and the required argument-hint", () => {
    const frontmatter = spine.slice(0, spine.indexOf("---", 3));
    expect(frontmatter).toMatch(/^---\ndescription: \S/);
    expect(frontmatter).toContain('argument-hint: "<org/repo#number>"');
  });

  it("keeps the explicit-target-only rule: no argument → [silent], no discovery", () => {
    const step0 = stepBlock("0");
    expect(step0).toContain("**required**");
    expect(step0).toContain("If `$ARGUMENTS` is empty");
    expect(step0).toContain("[silent]");
    expect(step0).toMatch(/no GitHub scan/);
    expect(spine).not.toContain("gh pr list");
  });

  it("states the no-size-exemption rule for subagent dispatches", () => {
    expect(norm(spine)).toMatch(/No size exemption/i);
    expect(norm(spine)).toMatch(/inline or sed-style fix counts as skipping/);
  });

  it("points at references/patch-lean/ for mechanics", () => {
    expect(spine).toContain("plugins/shipwright/references/patch-lean/");
  });
});

describe("patch-lean.md — a Proof line for every required-steps/patch.json step", () => {
  // The signal each step's Proof line must name, keyed by stepNumber. Every
  // patch.json step must appear here so a new required step fails this test.
  const expectedProof: Record<string, string[]> = {
    "3d": ["POST /prs/{id}/release"],
    "4a.6": ["POST /prs/claim", 'phase: "patch"', "pre-claim marker"],
    "4b": ["Agent dispatch"],
    "4c.5": ["POST /prs/{id}/patch", "commitSha", "heartbeat"],
    "5a.6": ["POST /prs/claim", 'phase: "patch"', "pre-claim marker"],
    "5a.6b": ["⏸", "no match"],
    "5a.7": ["Judgment:", "no candidate replies"],
    "5b": ["Agent dispatch"],
    "5c.5": ["POST /prs/{id}/patch", "POST /prs/{id}/findings", "heartbeat"],
    "6b.5": ["POST /prs/claim", 'phase: "patch"', "pre-claim marker"],
    "6b.6": ["GET", "⏸"],
    "6c": ["Agent dispatch"],
    "6d.5": ["POST /prs/{id}/patch", "ciFailureSignature", "heartbeat"],
    "6.5": ["is-ci-green.ts", "bonus dispatch"],
  };

  it("covers every step in patch.json", () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(Object.keys(expectedProof)).toContain(step.stepNumber);
    }
  });

  it("each patch.json step has its own block ending in a **Proof:** line", () => {
    for (const step of steps) {
      const block = stepBlock(step.stepNumber);
      expect({ step: step.stepNumber, found: block !== "" }).toEqual({
        step: step.stepNumber,
        found: true,
      });
      expect({
        step: step.stepNumber,
        hasProof: block.includes("**Proof:**"),
      }).toEqual({ step: step.stepNumber, hasProof: true });
    }
  });

  it("each Proof line names the patch.json proof signal", () => {
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

  it("the lane-specific dispatch steps exist for every lane in patch.json", () => {
    const lanes = new Set(steps.map((s) => s.lane));
    expect([...lanes].sort()).toEqual(["any", "ci", "conflict", "review"]);
    expect(stepBlock("4b")).toMatch(/conflict-resolution subagent/);
    expect(stepBlock("5b")).toMatch(/fix subagent/);
    expect(stepBlock("6c")).toMatch(/CI-fix subagent/);
  });

  it("the extra CI guards (6b.7, 6b.8, 6b.9) also carry Proof lines", () => {
    for (const n of ["6b.7", "6b.8", "6b.9"]) {
      expect(stepBlock(n)).toContain("**Proof:**");
    }
  });
});

describe("patch-lean.md — merged lane skeleton", () => {
  let skeleton: string;
  beforeAll(() => {
    const start = spine.indexOf("## Lane Skeleton");
    skeleton = spine.slice(start, spine.indexOf("## Step 4:", start));
  });

  it("lists setup, toolchain, claim, dispatch, status, upsert, cleanup in order", () => {
    let last = -1;
    for (const item of [
      "**Setup**",
      "**Toolchain**",
      "**Claim**",
      "**Dispatch**",
      "**Status**",
      "**Upsert**",
      "**Cleanup**",
    ]) {
      const idx = indexOfOrFail(skeleton, item);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("claim keeps the Pre-Claim Fast Path and the 409 skip", () => {
    expect(skeleton).toContain("Pre-Claim Fast Path");
    expect(skeleton).toContain("PRECLAIM_COMMIT_SHA");
    expect(skeleton).toContain("`PR_RECORD_ID = PRECLAIM_RECORD_ID`");
    expect(skeleton).toContain('`POST /prs/claim` with `phase: "patch"`');
    expect(skeleton).toContain("`409`");
    expect(skeleton).toContain(
      "⏸ PR #{pr} is already claimed by another patch run — skipping.",
    );
  });

  it("dispatch renews the heartbeat and runs PATCH_SUBAGENT_TYPE in the foreground", () => {
    expect(skeleton).toContain("POST /prs/{id}/heartbeat");
    expect(skeleton).toContain("PATCH_SUBAGENT_TYPE");
    expect(skeleton).toContain("model: PATCH_MODEL");
    expect(skeleton).toContain("run_in_background: false");
  });

  it("status handling retries unparseable STATUS and escalates BLOCKED via escalation-pattern.md", () => {
    expect(skeleton).toMatch(/no parseable `STATUS:` → retry once/);
    expect(skeleton).toContain("escalation-pattern.md");
  });

  it("upsert posts commitSha to POST /prs/{id}/patch", () => {
    expect(skeleton).toContain("`POST /prs/{id}/patch` with `commitSha`");
  });

  it("guards release the claim before moving on", () => {
    expect(skeleton).toContain("POST /prs/{id}/release");
  });

  it("each lane names its BLOCKED escalation slug", () => {
    expect(stepBlock("4c")).toContain("`blocked-4c`");
    expect(stepBlock("5c")).toContain("`blocked-5c`");
    expect(stepBlock("6d")).toContain("`blocked-6d`");
  });
});

describe("patch-lean.md — kept guards (DTA-9.6 'keep in spine')", () => {
  it("3d: pre-claim release with the no-op-at-dispatch skip-reason", () => {
    const block = stepBlock("3d");
    expect(block).toContain("PRECLAIM_RECORD_ID");
    expect(block).toContain(
      '"$SHIPWRIGHT_TASK_STORE_URL/prs/$PRECLAIM_RECORD_ID/release"',
    );
    expect(block).toContain(
      "[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]",
    );
    expect(block).toContain("[silent]");
    expect(block).toMatch(/settle-with-rejected/);
  });

  it("Step 0 parses the [preclaim:...] marker once", () => {
    expect(stepBlock("0")).toContain("[preclaim:{recordId}:{commitSha}]");
  });

  it("Step 2 keeps the exact (never substring) author-scope check", () => {
    expect(spine).toMatch(/\*\*exactly\*\* equals an\s+allowlist entry/);
    expect(spine).toContain("never a substring test");
    expect(spine).toContain(
      "⚠ PR {org}/{repo}#{number} not found among own open PRs.",
    );
  });

  it("dependency-risk trigger loads the reference on bot author or manifest/lockfile", () => {
    expect(spine).toContain("Dependency-risk trigger (DBP-1.2)");
    expect(spine).toMatch(/Renovate\/Dependabot bot/);
    expect(spine).toMatch(/package manifest or\s+lockfile/);
    expect(spine).toContain("../references/patch-lean/dependency-risk.md");
    expect(spine).toContain("dependency-risk@{headRefOid}");
  });

  it("5a.6b CDH-1.2: .claude/** path escalation on the first round", () => {
    const block = stepBlock("5a.6b");
    expect(block).toContain("CDH-1.2");
    expect(block).toContain("starts with `.claude/`");
    expect(block).toContain("`claude-dir`");
    expect(block).toMatch(/skip 5a\.7 and 5b/);
    expect(block).toMatch(/resolve \*\*all\*\* unresolved inline threads/);
  });

  it("5a.7 RPF-1.3: printed SAME/DIFFERENT judgment, timestamp alone never escalates", () => {
    const block = stepBlock("5a.7");
    expect(block).toContain("RPF-1.3");
    expect(block).toContain("`PR_AUTHOR`");
    expect(block).toContain("`Judgment: SAME_FINDING | DIFFERENT_FINDING`");
    expect(block).toContain("A timestamp alone never escalates.");
    expect(block).toContain("`escalation`");
    expect(block).toMatch(/no `reviewState` reset/);
  });

  it("6b.6 CFE-1.1: two fresh GETs, OR across tasks, release and stop", () => {
    const block = stepBlock("6b.6");
    expect(block).toContain("CFE-1.1");
    expect(block).toContain("GET /prs/{id}");
    expect(block).toContain("GET /tasks?repo={org}/{repo}&pr={pr}");
    expect(block).toContain('`hitl == true` OR `status == "blocked"`');
    expect(block).toContain(
      "⏸ PR #{pr} already has an unresolved HITL escalation — skipping CI-fix dispatch.",
    );
  });

  it("6b.7 PH-1.1: bundle gate with the verbatim skip-reason marker", () => {
    const block = stepBlock("6b.7");
    expect(block).toContain("PH-1.1");
    expect(block).toContain("GET /tasks?branch={branch}");
    expect(block).toContain("`pending`/`in_progress`/`blocked`");
    expect(block).toContain(
      "[skip-reason:patch:deferred:bundle-incomplete:{branch}]",
    );
    expect(block).toContain("[silent]");
  });

  it("6b.8 PCC-1.1: rerun-first with bounded, heartbeat-renewing poll", () => {
    const block = stepBlock("6b.8");
    expect(block).toContain("PCC-1.1");
    expect(block).toContain(
      "`CI_HAS_CANCELLED=true` and `CI_HAS_FAILING` is not true",
    );
    expect(block).toContain('gh run rerun "$CANCELLED_RUN_ID"');
    expect(block).toMatch(/every 15 s up to 8 times/);
    expect(block).toMatch(/renewing the heartbeat each iteration/);
  });

  it("6b.9 SLS-2.2: out-of-scope CI ledger write, never [silent] without it", () => {
    const block = stepBlock("6b.9");
    expect(block).toContain("SLS-2.2");
    expect(block).toContain("`ci:{headSha}:{ciFailureSignature}`");
    expect(norm(block)).toContain(
      '`source: "patch"`, `disposition: "rejected"`',
    );
    expect(norm(block)).toContain("Never exit `[silent]` without that entry.");
  });

  it("6b.9 MRB-1.1: main-red path blocks via escalation-pattern, no ledger write", () => {
    expect(norm(stepBlock("6b.9"))).toContain("`main_red:` block");
    const guard = norm(refs["guards-ci.md"]);
    expect(guard).toContain("latest completed CI run of the base branch");
    expect(guard).toContain("escalation-pattern.md");
    expect(guard).toContain("`main_red:`");
    expect(guard).toContain("/shipwright:unblock");
    expect(guard).toContain("skip 6c–6e");
    expect(guard).toContain("Do NOT write the `ci:` ledger entry");
  });

  it("6b computes CI_FAILURE_SIGNATURE in the spine (6b.9 and 6d.5 depend on it)", () => {
    expect(stepBlock("6b")).toContain("CI_FAILURE_SIGNATURE");
  });

  it("6.5 verifies CI with is-ci-green.ts and one bonus subagent", () => {
    const block = stepBlock("6.5");
    expect(block).toContain("is-ci-green.ts");
    expect(block).toMatch(/exactly one bonus CI-fix subagent/);
    expect(block).toContain(
      "⏭ No commit pushed this cycle — skipping CI verification.",
    );
  });

  it("Step 7 prints the PATCH COMPLETE report", () => {
    expect(stepBlock("7")).toContain("PATCH COMPLETE");
  });
});

describe("patch-lean.md — step ordering is behavior", () => {
  it("lanes run 4 → 5 → 6 → 6.5 → 7", () => {
    let last = -1;
    for (const h of [
      "## Step 4:",
      "## Step 5:",
      "## Step 6:",
      "## Step 6.5:",
      "## Step 7:",
    ]) {
      const idx = indexOfOrFail(spine, h);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("lane 5: claim → 5a.6b → 5a.7 → dispatch", () => {
    let last = -1;
    for (const b of [
      "- **5a.6** ",
      "- **5a.6b** ",
      "- **5a.7** ",
      "- **5b** ",
    ]) {
      const idx = indexOfOrFail(spine, b);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("lane 6: claim → 6b.6 → 6b.7 → 6b.8 → 6b.9 → dispatch", () => {
    let last = -1;
    for (const b of [
      "- **6b.5** ",
      "- **6b.6** ",
      "- **6b.7** ",
      "- **6b.8** ",
      "- **6b.9** ",
      "- **6c** ",
    ]) {
      const idx = indexOfOrFail(spine, b);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("lane 4: claim → dispatch → upsert", () => {
    let last = -1;
    for (const b of ["- **4a.6** ", "- **4b** ", "- **4c.5** "]) {
      const idx = indexOfOrFail(spine, b);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });
});

describe("patch-lean references — files exist and links resolve", () => {
  const expectedFiles = [
    "classification.md",
    "dependency-risk.md",
    "dropped-details.md",
    "guards-ci.md",
    "guards-escalation.md",
    "lane-ci.md",
    "lane-conflicts.md",
    "lane-findings.md",
    "lane-shared.md",
    "model-resolution.md",
    "verify-ci.md",
  ];

  it("ships the proposed reference files plus dropped-details.md", () => {
    expect(Object.keys(refs).sort()).toEqual(expectedFiles);
  });

  it("every relative link in the spine resolves", () => {
    const links = relativeLinks(spine);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = resolve(dirname(PATCH_LEAN_MD_PATH), link);
      expect({ link, exists: existsSync(target) }).toEqual({
        link,
        exists: true,
      });
    }
  });

  it("the spine links every reference file", () => {
    const linked = new Set(
      relativeLinks(spine).map((l) => resolve(dirname(PATCH_LEAN_MD_PATH), l)),
    );
    for (const f of expectedFiles) {
      expect({ f, linked: linked.has(join(REFERENCES_DIR, f)) }).toEqual({
        f,
        linked: true,
      });
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

  it("reuses the shared escalation-pattern.md and toolchain-patterns.md unchanged", () => {
    expect(spine).toContain("(references/escalation-pattern.md)");
    expect(spine).toContain("(../references/toolchain-patterns.md)");
  });
});

describe("patch-lean references — mechanics moved faithfully from patch.md", () => {
  // Load-bearing strings that must survive verbatim (whitespace-normalized):
  // escalation reasons, ledger refs, prompt headers, and script invocations.
  const verbatim = [
    '"merge-conflict resolution blocked — automated conflict resolution could not complete"',
    '"review-finding fix blocked — automated fix subagent could not complete"',
    '"CI-fix blocked — automated CI-fix subagent could not complete"',
    '"structurally unfixable — finding requires a write under .claude/**, which the Claude Code CLI blocks unconditionally — escalated to HITL"',
    '"second-round disagreement between reviewer and automated fix — escalated to HITL"',
    "/tmp/shipwright-patch-claude-dir-{pr}.txt",
    "/tmp/shipwright-patch-escalation-{pr}.txt",
    "thread:{thread.id}@{comments.totalCount}",
    "{review.commit.oid}@{review.submittedAt}",
    'resolveReviewThread(input: {threadId: "{thread.id}"})',
    "DEPENDENCY-RISK REMEDIATION PROTOCOL (references/dependency-patch.md):",
    "You are resolving merge conflicts on a pull request.",
    "You are addressing review findings on a pull request.",
    "You are fixing failing CI on a pull request.",
    "NOTE — REPEATED TIMEOUT/HANG SIGNAL",
    "compute-unaddressed-findings.ts",
    "filter-bot-comments.ts",
    "resolve-dependency-watched-paths.ts",
    "is-ci-green.ts",
    '{repo: $repo, prNumber: $prNumber, commitSha: $commitSha, phase: "patch", authorLogin: $authorLogin, headRef: $headRef, title: $title}',
    "Judgment: SAME_FINDING | DIFFERENT_FINDING",
    "Deferring CI-fix dispatch until bundle-mates reach pr_open.",
    "cancelled run {CANCELLED_RUN_ID} rerun succeeded, no fix needed — skipping CI-fix dispatch.",
    "PATCH COMPLETE",
  ];

  it("each load-bearing string appears in both patch.md and the patch-lean corpus", () => {
    const normPatch = norm(patchMd);
    const normCorpus = norm(corpus);
    for (const s of verbatim) {
      expect({ s, inPatch: normPatch.includes(norm(s)) }).toEqual({
        s,
        inPatch: true,
      });
      expect({ s, inLean: normCorpus.includes(norm(s)) }).toEqual({
        s,
        inLean: true,
      });
    }
  });

  it("the dependency-risk already-held exclusion is kept whole", () => {
    const dep = refs["dependency-risk.md"];
    expect(dep).toContain('--arg ref "dependency-risk@{headRefOid}"');
    expect(dep).toMatch(/clear `DEPENDENCY_RISK_FINDING` back to unset/);
  });

  it("dropped-details.md records what was cut and why", () => {
    const dropped = refs["dropped-details.md"];
    expect(dropped).toContain("| Dropped | Reason |");
    expect(dropped).toMatch(/Why this is re-derived/);
    expect(dropped).toMatch(/Design note/);
  });
});

describe("patch-lean — not wired to any cron or default dispatch", () => {
  it("is absent from the coding specialty cron defaults and the loop's PHASE_COMMANDS", () => {
    for (const rel of [
      "admin/src/coding/coding-specialty-defaults.ts",
      "agent/src/coding/loop-orchestrator.ts",
    ]) {
      const path = join(REPO_ROOT, rel);
      if (!existsSync(path)) continue;
      expect({
        rel,
        mentions: readFileSync(path, "utf-8").includes("patch-lean"),
      }).toEqual({ rel, mentions: false });
    }
  });

  it("patch.md does not reference the lean variant", () => {
    expect(patchMd).not.toContain("patch-lean");
  });
});
