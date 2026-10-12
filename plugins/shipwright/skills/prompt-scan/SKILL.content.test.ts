/**
 * prompt-scan content tests — PAU-3.9
 *
 * Verifies the skill, its command stub and its references: flags, step order,
 * Constraints section, and citations of the shared decisions-registry doc.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const STUB_PATH = join(import.meta.dir, "../../commands/prompt-scan.md");
const LEDGER_SCHEMA_PATH = join(import.meta.dir, "references/ledger-schema.md");
const THRESHOLDS_PATH = join(import.meta.dir, "references/thresholds.md");

const skill = () => readFileSync(SKILL_MD_PATH, "utf8");
const stub = () => readFileSync(STUB_PATH, "utf8");

const FLAGS = [
  "--summary",
  "--dry-run",
  "--model",
  "--scope",
  "--with-doctor",
  "--since-days",
];

describe("prompt-scan — files exist", () => {
  it.each([SKILL_MD_PATH, STUB_PATH, LEDGER_SCHEMA_PATH, THRESHOLDS_PATH])(
    "%s exists",
    (p) => {
      expect(existsSync(p)).toBe(true);
    },
  );
});

describe("prompt-scan — SKILL.md", () => {
  it("has frontmatter naming the skill", () => {
    expect(skill()).toMatch(/^---\nname: prompt-scan\n/);
  });

  it.each(FLAGS)("documents %s", (flag) => {
    expect(skill()).toContain(flag);
  });

  it("states the default model list", () => {
    const text = skill();
    expect(text).toContain("ANTHROPIC_MODEL");
    expect(text).toContain("claude-sonnet-5-5");
    expect(text).toContain("claude-sonnet-4-6");
  });

  it("steps appear in order", () => {
    const text = skill();
    const headings = [
      "## Setup: Parse Arguments",
      "## Step 1: Load the Decisions Registry",
      "## Step 2: Load the Ledger",
      "## Step 3: Run the Deterministic Scan",
      "## Step 4: Judgment Pass — Class (e)",
      "## Step 5: Judgment Pass — Class (d)",
      "## Step 6: Fingerprint, Suppress and Merge",
      "## Step 7: Write the Ledger",
      "## Step 8: Write the Report",
      "## Step 9: Print Summary",
      "## Constraints (Do Not Violate)",
    ];
    const positions = headings.map((h) => text.indexOf(h));
    for (const [i, pos] of positions.entries()) {
      expect(pos, headings[i]).toBeGreaterThanOrEqual(0);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("runs the CLI scan with --json and --dry-run", () => {
    expect(skill()).toContain("cli.ts scan --json --dry-run");
  });

  it("cites the shared decisions-registry doc and the registry file", () => {
    const text = skill();
    expect(text).toContain("references/decisions-registry.md");
    expect(text).toContain(".claude/shipwright/prompt-audit-decisions.md");
  });

  it("treats a missing registry as a graceful no-op", () => {
    expect(skill()).toContain("no suppressions configured");
  });

  it("records suppressed findings in the ledger", () => {
    const text = skill();
    expect(text).toContain("`suppressed`");
    expect(text).toContain("**Finding**");
  });

  it("covers class e move-to-path-rule and class d via /doctor with a claude-api fallback", () => {
    const text = skill();
    expect(text).toContain("move-to-path-rule");
    expect(text).toContain("/doctor prompt-audit");
    expect(text).toContain("claude-api");
    expect(text).toContain("two consecutive runs");
  });

  it("Step 6 spells out the class (d)/(e) promotions and the consecutiveRuns counter", () => {
    const step6 = skill()
      .split("## Step 6: Fingerprint, Suppress and Merge")[1]
      ?.split("## Step 7")[0];
    expect(step6).toBeDefined();
    expect(step6).toContain("**Class (d) counter.**");
    expect(step6).toContain("**Class (d) promotion.**");
    expect(step6).toContain("**Class (e) promotion.**");
    expect(step6).toContain("`consecutiveRuns >= 2`");
    expect(step6).toContain("`consecutiveRuns: 0`");
    expect(step6).toContain("`promoted`");
    expect(step6).toContain("Promotion applies only to `tracking`.");
  });

  it("Step 5 and Step 6 agree that a miss resets the counter but not the status", () => {
    const text = skill();
    expect(text).toContain("resets to `0` on any run it is missed");
    expect(text).toContain("left unchanged by the miss");
    expect(text).not.toContain("Absent fingerprint: leave unchanged,");
  });

  it("skips ledger and report writes under the right flags", () => {
    const text = skill();
    expect(text).toContain("Skip this step if `--dry-run` was passed");
    expect(text).toContain(
      "Skip this step if `--summary` or `--dry-run` was passed",
    );
  });

  it("has a Constraints section forbidding edits and CLI writes", () => {
    const constraints = skill().split("## Constraints (Do Not Violate)")[1];
    expect(constraints).toBeDefined();
    expect(constraints).toContain("No prompt edits");
    expect(constraints).toContain("Never let the CLI write");
  });
});

describe("prompt-scan — command stub", () => {
  it("has frontmatter naming the command", () => {
    expect(stub()).toMatch(/^---\nname: prompt-scan\n/);
  });

  it.each(FLAGS)("documents %s", (flag) => {
    expect(stub()).toContain(flag);
  });

  it("invokes the prompt-scan skill", () => {
    expect(stub()).toContain("Invoke the prompt-scan skill.");
  });
});

describe("prompt-scan — ledger-schema.md", () => {
  it("documents every finding status", () => {
    const text = readFileSync(LEDGER_SCHEMA_PATH, "utf8");
    for (const s of [
      "tracking",
      "proposed",
      "queued",
      "measured",
      "regressed",
      "resolved",
      "suppressed",
    ]) {
      expect(text).toContain(`\`${s}\``);
    }
  });

  it("documents the fingerprint formula and append-only history", () => {
    const text = readFileSync(LEDGER_SCHEMA_PATH, "utf8");
    expect(text).toContain("sha256(class|rule|file|normalizedEvidence)[:12]");
    expect(text).toContain("append-only");
  });

  it("documents the consecutiveRuns counter and class (d)/(e) promotion", () => {
    const text = readFileSync(LEDGER_SCHEMA_PATH, "utf8");
    expect(text).toContain("`consecutiveRuns >= 2`");
    expect(text).toContain("history event `promoted`");
    expect(text).toContain("Promotion only ever leaves `tracking`.");
    expect(text).toContain(
      "`mergeScan` and `LedgerEntry` do not implement them yet",
    );
  });
});
