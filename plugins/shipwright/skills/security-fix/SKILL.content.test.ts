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
  it("has frontmatter with name: security-fix", () => {
    expect(content).toContain("name: security-fix");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — reads open PatrolFindings from the store", () => {
  it("reads findings from GET /patrol-findings for the repo", () => {
    expect(content).toContain("/patrol-findings?cronId=");
    expect(content).toContain("status=open");
  });

  it("requires security-scan to have run first", () => {
    expect(content).toContain("/security-scan");
  });

  it("sets taskId back on routed findings", () => {
    expect(content).toContain("/patrol-findings/batch");
    expect(content).toContain('"taskId"');
  });
});

describe("SKILL.md — requires --repo (PCR-3.3)", () => {
  it("documents --repo as required with a usage error", () => {
    expect(content).toContain("`--repo org/repo` — **required**");
    expect(content).toContain("Usage: /security-fix --repo org/repo");
    expect(content).toContain("Error: --repo is required.");
  });

  it("takes the system-cron id via --cron", () => {
    expect(content).toContain("--cron ID");
  });
});

describe("SKILL.md — no repo write path, no legacy state files (PCR-3.3)", () => {
  it("never mentions security-report.md or a docs/ output", () => {
    expect(content).not.toContain("security-report.md");
    expect(content).not.toContain("docs/");
  });

  it("never reads or writes the legacy state files", () => {
    expect(content).not.toContain("security-patrol-ledger");
    expect(content).not.toContain("security-patrol-last-run");
    expect(content).not.toContain("--legacy-shape");
  });

  it("keeps temp files outside the repo", () => {
    expect(content).toContain("mktemp");
  });
});

describe("SKILL.md — three routes plus the credential exception (PCR-3.3)", () => {
  it("documents auto, review and plan route shapes", () => {
    expect(content).toContain(
      "auto = `kind: dev`, `status: pending`, `hitl: false`",
    );
    expect(content).toContain("review = `kind: dev`");
    expect(content).toContain("needs-review:");
    expect(content).toContain("POST /tasks/{id}/unblock");
    expect(content).toContain("plan = `kind: prd`");
  });

  it("stamps routed tasks with originKind cron and the cron id as originRef", () => {
    expect(content).toContain('"originKind": "cron"');
    expect(content).toContain('"originRef": "<CRON_ID>"');
  });

  it("records one run with auto/review/plan metrics", () => {
    expect(content).toContain("cron-run-recorder.ts");
    expect(content).toContain('"auto":N,"review":N,"plan":N');
  });

  it("keeps credential findings as the only hitl:true dev route via /shipwright:hitl", () => {
    expect(content).toContain("the one human-only\nexception");
    expect(content).toContain(
      "`hitl: true`, `kind: dev`, with a\n  `## Human steps`",
    );
    expect(content).toContain("only `hitl: true` dev tasks");
  });

  it("never makes a previously-human finding auto", () => {
    expect(content).toContain("Never-auto rule");
    expect(content).toContain("must never become `auto`");
    expect(content).toContain("never toward `auto`");
    expect(content).toContain("Never auto a previously-human finding");
  });

  it("maps the per-finding authz rule to auto, review or plan, never hitl:true", () => {
    const idx = content.indexOf("| `authz-missing-check`");
    const row = content.slice(idx, idx + 250);
    expect(row).toContain("auto, review or plan");
  });

  it("routes unconfirmable pre-filing findings to review, not auto", () => {
    expect(content).toContain("routes `review`, never `auto`");
  });
});

describe("SKILL.md — Setup: flags", () => {
  it("documents --dry-run flag", () => {
    expect(content).toContain("--dry-run");
  });

  it("documents --rule flag", () => {
    expect(content).toContain("--rule");
  });

  it("instructs to cd into the --repo local clone", () => {
    expect(content).toContain("`cd` into the repo's local clone before Step 1");
  });
});

describe("SKILL.md — bulk task-store POST pattern", () => {
  it("references the /tasks/bulk endpoint", () => {
    expect(content).toContain("/tasks/bulk");
  });

  it("writes a temp file outside the repo before posting", () => {
    expect(content).toContain("security-tasks.json");
    expect(content).toContain("mktemp");
  });
});

describe("SKILL.md — repo-namespaced task ID format", () => {
  it("documents the security-{rule}-{repo-slug}-{YYYY-Www} ID format", () => {
    expect(content).toContain("security-{rule}-{repo-slug}-{YYYY-Www}");
  });

  it("documents repo-slug derivation (last path segment, lowercased)", () => {
    expect(content).toContain("repo-slug");
  });

  it("explains the collision-avoidance rationale", () => {
    const hasRationale =
      content.toLowerCase().includes("collision") ||
      content.toLowerCase().includes("collide");
    expect(hasRationale).toBe(true);
  });
});

describe("SKILL.md — dedup check", () => {
  it("checks source == shipwright", () => {
    expect(content).toContain('source == "shipwright"');
  });

  it("checks title prefix 'Security fix:'", () => {
    expect(content).toContain("Security fix:");
  });

  it("documents the dedup check step (6q.1 style)", () => {
    expect(content.toLowerCase()).toContain("dedup");
  });
});

describe("SKILL.md — dedup check widened to recently-closed done tasks", () => {
  it("queries status=done scoped by repo", () => {
    expect(content).toContain("status=done");
  });

  it("queries using the updatedSince param", () => {
    expect(content).toContain("updatedSince");
  });

  it("documents a 14-day lookback window", () => {
    expect(content).toContain("14-day");
  });

  it("has a distinct skip message for recently-closed done tasks", () => {
    expect(content).toContain("still within 14-day dedup window");
  });

  it("keeps the existing 'task already active' skip message unchanged for pending/in_progress", () => {
    expect(content).toContain("Skipping {rule} — task already active");
  });

  it("distinguishes recently-closed from already-active in the skip wording", () => {
    const hasClosedWording =
      content.toLowerCase().includes("closed {date}") ||
      content.toLowerCase().includes("recently closed") ||
      content.toLowerCase().includes("recently-closed");
    expect(hasClosedWording).toBe(true);
  });

  it("resolves {outcome} from the done task's note field first", () => {
    expect(content).toContain("the done task's `note`");
  });

  it("documents note as the field hitl.md Step 6 sets from the human's close-out summary", () => {
    expect(content).toContain("/shipwright:hitl` Step 6 optionally sets");
  });

  it("falls back to blockedReason, then the literal 'resolved', when note is absent", () => {
    expect(content).toContain("then its `blockedReason`");
    expect(content).toContain('then the literal\n`"resolved"`');
  });
});

describe("SKILL.md — embedded rule classification table", () => {
  const rules = [
    "gitleaks-secret",
    "osv-cve",
    "grype-cve",
    "zizmor-lint",
    "authz-missing-check",
    "secret-weak-compare",
    "hardcoded-credential",
    "posture-security-md-missing",
    "posture-sbom-missing",
    "posture-branch-protection-missing",
  ];

  for (const rule of rules) {
    it(`classifies rule ${rule}`, () => {
      expect(content).toContain(rule);
    });
  }

  it("does not depend on references/principles.md (that's a different rule set)", () => {
    expect(content).not.toContain("references/principles.md");
  });
});

describe("SKILL.md — credential-rotation findings route through HITL", () => {
  it("mentions requires-credential-action", () => {
    expect(content).toContain("requires-credential-action");
  });

  it("has a ## Human steps section", () => {
    expect(content).toContain("## Human steps");
  });

  it("references /shipwright:hitl", () => {
    expect(content).toContain("/shipwright:hitl");
  });

  it("states credential-rotation findings are never auto-remediated", () => {
    const hasNeverAutoRemediate =
      content.toLowerCase().includes("never auto-remediated") ||
      content.toLowerCase().includes("never autonomously") ||
      content.toLowerCase().includes("not auto-remediated");
    expect(hasNeverAutoRemediate).toBe(true);
  });

  it("classifies gitleaks-secret as HITL: always / requires-credential-action: true", () => {
    const gitleaksSection = content.slice(
      content.indexOf("gitleaks-secret"),
      content.indexOf("gitleaks-secret") + 400,
    );
    expect(gitleaksSection).toContain("always");
    expect(gitleaksSection.toLowerCase()).toContain("true");
  });

  it("classifies hardcoded-credential as HITL: always / requires-credential-action: true", () => {
    const idx = content.indexOf("| `hardcoded-credential`");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx, idx + 400);
    expect(section).toContain("always");
  });
});

describe("SKILL.md — at least one autonomous PR-worthy rule is HITL: never", () => {
  it("classifies osv-cve as HITL: never", () => {
    const idx = content.indexOf("| `osv-cve`");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx, idx + 200);
    expect(section).toContain("never");
  });
});

describe("SKILL.md — Constraints section", () => {
  it("has a ## Constraints section", () => {
    expect(content).toMatch(/## Constraints/);
  });

  it("declares queue-only behavior (never opens PRs)", () => {
    expect(content.toLowerCase()).toContain("never opens prs");
  });

  it("declares one task per rule", () => {
    expect(content.toLowerCase()).toContain("one task per rule");
  });
});

describe("SKILL.md — Error Handling section", () => {
  it("has an ## Error Handling section", () => {
    expect(content).toMatch(/## Error Handling/);
  });
});

describe("SKILL.md — honors suppressions (.shipwright/suppressions.yml)", () => {
  it("re-checks suppressions between filtering and dry-run/dedup", () => {
    const step = content.indexOf("## Step 3.5: Re-check Suppressions");
    expect(step).toBeGreaterThan(
      content.indexOf("## Step 3: Filter and Group Findings"),
    );
    expect(step).toBeLessThan(content.indexOf("## Step 5: Dry-Run Output"));
  });

  it("reads .shipwright/suppressions.yml via the shared script", () => {
    expect(content).toContain(".shipwright/suppressions.yml");
    expect(content).toContain('suppressions.ts" --filter');
  });

  it("uses a skip message distinct from the active/recently-closed ones", () => {
    expect(content).toMatch(
      /Skipping .* suppressed in \.shipwright\/suppressions\.yml/,
    );
    expect(content).toContain(
      "Skipped (suppressed in .shipwright/suppressions.yml)",
    );
  });

  it("only treats osv/grype/posture findings as suppression candidates", () => {
    expect(content).toContain('{rule: "osv"|"grype", cve');
  });
});

describe("PLU-4.4 origin provenance", () => {
  it("files tasks with originKind cron and the system-cron id as originRef", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"originKind": "cron"');
    expect(text).toContain('"originRef": "<CRON_ID>"');
  });

  it("still writes source unchanged", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"source": "security-fix"');
  });
});
