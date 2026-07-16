import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_PATCH_MD_PATH = join(import.meta.dir, "review-patch.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_PATCH_MD_PATH, "utf-8");
});

describe("review-patch.md — precheck invocations", () => {
  it("references the check-patch precheck script", () => {
    expect(content).toContain("check-patch");
  });

  it("references the check-review precheck script", () => {
    expect(content).toContain("check-review");
  });

  it("runs check-patch as a bash command", () => {
    expect(content).toContain('bun "$CHECK_SCRIPTS/check-patch.ts"');
  });

  it("runs check-review as a bash command", () => {
    expect(content).toContain('bun "$CHECK_SCRIPTS/check-review.ts"');
  });
});

describe("review-patch.md — sub-agent spawning", () => {
  it("spawns /shipwright:patch as a sub-agent when check-patch exits 0", () => {
    expect(content).toContain("/shipwright:patch");
  });

  it("spawns /shipwright:review as a sub-agent when check-review exits 0", () => {
    expect(content).toContain("/shipwright:review");
  });

  it("uses the Agent tool to dispatch sub-agents", () => {
    expect(content).toContain("Agent");
  });
});

describe("review-patch.md — silent marker when nothing to do", () => {
  it("appends [silent] when neither precheck triggers on the first pass", () => {
    expect(content).toContain("[silent]");
  });
});

describe("review-patch.md — 25-minute timeout", () => {
  it("has a 25-minute elapsed budget", () => {
    expect(content).toContain("25");
  });

  it("prints a timeout notice when the budget is exceeded", () => {
    expect(content.toLowerCase()).toContain("timeout");
  });
});

describe("review-patch.md — loop exit condition", () => {
  it("loops until both prechecks return exit 1", () => {
    expect(content).toContain("exit 1");
  });

  it("breaks the loop when both prechecks return nothing to do", () => {
    expect(content.toLowerCase()).toContain("break");
  });
});

describe("review-patch.md — orchestrator shape (not a Workflow pipeline)", () => {
  it("does NOT use the Workflow tool", () => {
    expect(content).not.toContain("pipeline(");
  });

  it("records start time at the beginning", () => {
    expect(content.toLowerCase()).toContain("start time");
  });
});

describe("review-patch.md — plugin script depth resolution", () => {
  it("uses maxdepth 5 to find precheck scripts in the cache layout", () => {
    expect(content).toContain("maxdepth 5");
  });
});

describe("review-patch.md — explicit-target patch dispatch (WLS-3.3 follow-up)", () => {
  it("Step 3b captures check-patch's stdout instead of discarding it", () => {
    const step3bIdx = content.indexOf(
      "### Step 3b: Run check-patch — spawn /shipwright:patch if triggered",
    );
    const step3cIdx = content.indexOf(
      "### Step 3c: Run check-review — spawn /shipwright:review if triggered",
    );
    expect(step3bIdx).toBeGreaterThan(-1);
    expect(step3cIdx).toBeGreaterThan(-1);
    const step3bSection = content.slice(step3bIdx, step3cIdx);
    expect(step3bSection).toContain(
      'PATCH_TARGET=$(bun "$CHECK_SCRIPTS/check-patch.ts")',
    );
  });

  it("Step 3b dispatches the sub-agent with the captured explicit target, not a bare /shipwright:patch", () => {
    const step3bIdx = content.indexOf(
      "### Step 3b: Run check-patch — spawn /shipwright:patch if triggered",
    );
    const step3cIdx = content.indexOf(
      "### Step 3c: Run check-review — spawn /shipwright:review if triggered",
    );
    const step3bSection = content.slice(step3bIdx, step3cIdx);
    expect(step3bSection).toContain("PATCH_TARGET");
    expect(step3bSection).not.toContain(
      "Pass no additional arguments — the patch skill discovers its own inputs from GitHub.",
    );
  });

  it("Migration Notes documents the explicit-target dispatch behavior", () => {
    const migrationIdx = content.indexOf("## Migration Notes");
    expect(migrationIdx).toBeGreaterThan(-1);
    const migrationSection = content.slice(migrationIdx);
    expect(migrationSection).toContain("Explicit-target dispatch");
    expect(migrationSection).toContain("org/repo#number");
  });
});
