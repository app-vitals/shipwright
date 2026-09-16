/**
 * BOOTSTRAP.md.template content regression guard — ABF-1.1
 *
 * Verifies the first-run bootstrap template's cron-walkthrough step describes
 * the shipwright-loop-driven, explicit-target-only pipeline model (mirrors
 * CLAUDE.md.template.content.test.ts / DPF-1.1), not the stale "every 30 min,
 * self-discovering pickup of approved todos" model it replaced.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// agent/workspace/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..");

function repoPath(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

function readTemplate(): string {
  return readFileSync(repoPath("agent/workspace/BOOTSTRAP.md.template"), "utf8");
}

describe("BOOTSTRAP.md.template — shipwright-loop model", () => {
  it("mentions the shipwright-loop cron as the driver", () => {
    expect(readTemplate()).toContain("shipwright-loop");
  });

  it("describes dev-task/review/patch as explicit-target-only executors", () => {
    expect(readTemplate().toLowerCase()).toContain("explicit-target-only");
  });

  it("mentions strict age-based FIFO work selection", () => {
    expect(readTemplate().toLowerCase()).toContain("fifo");
  });

  it("notes a standalone phase cron with shipwright-loop disabled is silently inert", () => {
    expect(readTemplate().toLowerCase()).toContain("silently inert");
  });

  it("does not claim the phase crons run every 30 minutes", () => {
    expect(readTemplate()).not.toContain("30 min");
  });

  it("does not claim approved todos are picked up automatically without a driving loop", () => {
    expect(readTemplate()).not.toContain(
      "Once a task is approved, it gets picked up automatically.",
    );
  });
});
