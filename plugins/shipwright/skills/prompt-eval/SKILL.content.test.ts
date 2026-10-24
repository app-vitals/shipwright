/**
 * prompt-eval content tests — PAU-5.3
 *
 * Verifies the skill and its command stub: flags, the calibration gate, the
 * cost gate, MDE wording, the sandbox caveat and the no-cron rule.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const STUB_PATH = join(import.meta.dir, "../../commands/prompt-eval.md");
const HARNESS_PATH = join(
  import.meta.dir,
  "../../scripts/prompt-audit/eval-harness.ts",
);

const skill = () => readFileSync(SKILL_MD_PATH, "utf8");
const stub = () => readFileSync(STUB_PATH, "utf8");

describe("prompt-eval — files exist", () => {
  it.each([SKILL_MD_PATH, STUB_PATH, HARNESS_PATH])("%s exists", (p) => {
    expect(existsSync(p)).toBe(true);
  });
});

describe("prompt-eval — stub", () => {
  it("has the name, names the flags, and invokes the skill", () => {
    const text = stub();
    expect(text).toMatch(/^---\nname: prompt-eval\n/);
    for (const flag of [
      "--finding",
      "--kind",
      "--max-cost-usd",
      "--model",
      "--runs",
    ])
      expect(text).toContain(flag);
    expect(text).toContain("Invoke the `prompt-eval` skill.");
  });
});

describe("prompt-eval — SKILL.md", () => {
  it("has frontmatter naming the skill", () => {
    expect(skill()).toMatch(/^---\nname: prompt-eval\n/);
  });

  it.each([
    "--finding <fp>",
    "--kind with-without|ab|trigger|production-series",
    "--max-cost-usd <n>",
    "--model <id>",
    "--runs <n>",
  ])("documents %s", (flag) => {
    expect(skill()).toContain(flag);
  });

  it("defaults the cap to 5 and runs to 3", () => {
    const text = skill();
    expect(text).toContain("default `5`");
    expect(text).toContain("default `3`");
  });

  it("steps appear in order", () => {
    const text = skill();
    const headings = [
      "## Setup: Parse Arguments",
      "## Step 1: Calibration Gate",
      "## Step 2: Cost Gate",
      "## Step 3: Run",
      "## Step 4: Report",
      "## Step 5: Record",
      "## Constraints (Do Not Violate)",
    ];
    let last = -1;
    for (const h of headings) {
      const idx = text.indexOf(h);
      expect(idx, `missing heading: ${h}`).toBeGreaterThan(-1);
      expect(idx, `out of order: ${h}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("states evals run only inside a fix task or by a human, never from the cron", () => {
    const text = skill();
    expect(text).toMatch(
      /Evals run only inside a fix task[\s\S]*?by a human, never from the cron\./,
    );
    expect(text).toContain("Refusing to run: evals never run from the cron.");
  });

  it("gates quality on a signed passing calibration record", () => {
    const text = skill();
    expect(text).toContain("docs/prompt-audit-calibration.md");
    expect(text).toContain("signed passing");
    expect(text).toContain("**No calibration record.**");
    expect(text).toContain("Refuse any quality result and say why");
    expect(text).toContain("no signed calibration record");
  });

  it("reports cost-only output and runs no model arm on a failed record", () => {
    const text = skill();
    expect(text).toContain("**Failed record.**");
    expect(text).toContain("cost-only output");
    expect(text).toContain("run no model arm");
    expect(text).toContain("calibration failed");
  });

  it("calibration gate comes before the cost gate and the run", () => {
    const text = skill();
    expect(text.indexOf("## Step 1: Calibration Gate")).toBeLessThan(
      text.indexOf("## Step 2: Cost Gate"),
    );
    expect(text.indexOf("## Step 2: Cost Gate")).toBeLessThan(
      text.indexOf("## Step 3: Run"),
    );
  });

  it("prints the estimated cost before running and refuses without a cap", () => {
    const text = skill();
    expect(text).toContain("Print the estimated cost before running");
    expect(text).toContain("Refuse without a cap");
    expect(text).toContain("assertCostGate");
    expect(text).toContain("estimateEvalCost");
  });

  it("uses MDE wording and never states quality unchanged", () => {
    const text = skill();
    expect(text).toContain("minimum detectable effect (MDE)");
    expect(text).toContain("no-regression-detected-within-MDE");
    expect(text).toContain("Never state that\n  quality is unchanged");
    expect(text).toContain("11-16 points");
  });

  it("states the sandbox caveat", () => {
    const text = skill();
    expect(text).toContain("**Sandbox caveat.**");
    expect(text).toContain("SHIPWRIGHT_TASK_STORE_*");
    expect(text).toContain("inert");
    expect(text).toContain("append_system_prompt");
  });

  it("emits a PR-citable block and records measured", () => {
    const text = skill();
    expect(text).toContain("## Prompt eval — {fp}");
    expect(text).toContain("PR-citable block");
    expect(text).toContain("ledger.findings[fp].measured");
  });
});
